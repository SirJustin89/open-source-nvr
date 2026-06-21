/**
 * Network scanner for discovering IP cameras on the local subnet.
 *
 * Uses pure Node.js net.Socket TCP probes — no extra dependencies.
 * Scans all 254 hosts of a /24 subnet concurrently in batches to avoid
 * hitting OS file-descriptor limits.
 */

import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';

export interface ScanResult {
    ip: string;
    openPorts: number[];
    vendor?: string;
}

/** Common ports found on IP cameras */
const CAMERA_PORTS = [80, 554, 8080, 443, 8000, 8443];

/** Per-batch concurrency limit to avoid EMFILE errors */
const BATCH_SIZE = 50;

/** TCP connect timeout in ms */
const CONNECT_TIMEOUT_MS = 300;

/** HTTP fetch timeout in ms used for vendor fingerprinting */
const HTTP_TIMEOUT_MS = 1500;

/**
 * Probe a single TCP port on an IP address.
 * Resolves true if the port is open (connection accepted), false otherwise.
 */
function probePort(ip: string, port: number): Promise<boolean> {
    return new Promise((resolve) => {
        const socket = new net.Socket();
        let settled = false;

        const done = (open: boolean) => {
            if (settled) return;
            settled = true;
            socket.destroy();
            resolve(open);
        };

        socket.setTimeout(CONNECT_TIMEOUT_MS);
        socket.on('connect', () => done(true));
        socket.on('timeout', () => done(false));
        socket.on('error', () => done(false));
        socket.connect(port, ip);
    });
}

/**
 * Make a single HTTP/HTTPS GET request for camera fingerprinting.
 * Uses a lenient HTTPS agent (rejectUnauthorized: false) since IP cameras
 * almost always use self-signed certificates.
 * Resolves with the HTTP status code, or rejects on network/timeout error.
 */
function httpGet(url: string, timeoutMs: number): Promise<number> {
    return new Promise((resolve, reject) => {
        const parsed = new URL(url);
        const isHttps = parsed.protocol === 'https:';
        const mod = isHttps ? https : http;
        const options = {
            hostname: parsed.hostname,
            port: parsed.port,
            path: parsed.pathname + parsed.search,
            method: 'GET',
            timeout: timeoutMs,
            // Accept self-signed certs — cameras almost always have them
            ...(isHttps ? { rejectUnauthorized: false } : {}),
        };
        const req = mod.request(options, (res) => {
            // Consume and discard body so the socket is released
            res.resume();
            resolve(res.statusCode ?? 0);
        });
        req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
        req.on('error', reject);
        req.end();
    });
}

/**
 * Attempt to fingerprint the camera vendor by probing well-known HTTP
 * endpoints.  Returns a vendor string if recognised, undefined otherwise.
 */
async function fingerprint(ip: string, port: number): Promise<string | undefined> {
    const endpoints: { path: string; vendor: string }[] = [
        { path: '/api.cgi?cmd=GetDevInfo', vendor: 'Reolink' },
        { path: '/cgi-bin/api.cgi?cmd=GetDevInfo', vendor: 'Reolink' },
        { path: '/onvif/device_service', vendor: 'ONVIF' },
        { path: '/web/cgi-bin/hi3510/param.cgi', vendor: 'Hikvision' },
        { path: '/ISAPI/System/deviceInfo', vendor: 'Hikvision' },
        { path: '/cgi-bin/magicBox.cgi?action=getProductDefinition', vendor: 'Dahua' },
    ];

    const protocol = port === 443 || port === 8443 ? 'https' : 'http';

    for (const ep of endpoints) {
        const url = `${protocol}://${ip}:${port}${ep.path}`;
        try {
            const status = await httpGet(url, HTTP_TIMEOUT_MS);
            // Any response (including 401 Unauthorized) means the server is there.
            if (status > 0 && status < 500) {
                return ep.vendor;
            }
        } catch {
            // Ignore — try next endpoint
        }
    }
    return undefined;
}

/**
 * Run TCP probes for all requested ports on a single IP.
 * Returns undefined if no ports are open, otherwise a ScanResult.
 */
async function scanHost(ip: string): Promise<ScanResult | undefined> {
    const results = await Promise.all(CAMERA_PORTS.map(p => probePort(ip, p)));
    const openPorts = CAMERA_PORTS.filter((_, i) => results[i] === true);

    if (openPorts.length === 0) return undefined;

    // Try to fingerprint using the first open HTTP-ish port
    const httpPort = openPorts.find(p => p === 80 || p === 8080 || p === 443 || p === 8443);
    const vendor = httpPort !== undefined ? await fingerprint(ip, httpPort) : undefined;

    return { ip, openPorts, vendor };
}

/**
 * Run tasks in batches of BATCH_SIZE to limit concurrency.
 */
async function runInBatches<T>(tasks: (() => Promise<T>)[]): Promise<T[]> {
    const results: T[] = [];
    for (let i = 0; i < tasks.length; i += BATCH_SIZE) {
        const batch = tasks.slice(i, i + BATCH_SIZE).map(t => t());
        const settled = await Promise.allSettled(batch);
        for (const s of settled) {
            if (s.status === 'fulfilled') results.push(s.value);
        }
    }
    return results;
}

/**
 * Auto-detect the server's local /24 subnet from OS network interfaces.
 * Skips loopback and link-local addresses.
 * Returns e.g. "192.168.1" (the first three octets) or undefined if nothing found.
 */
export function detectLocalSubnet(): string | undefined {
    const ifaces = os.networkInterfaces();
    for (const name of Object.keys(ifaces)) {
        const addrs = ifaces[name];
        if (!addrs) continue;
        for (const addr of addrs) {
            if (addr.family !== 'IPv4') continue;
            if (addr.internal) continue;
            // Skip link-local (169.254.x.x)
            if (addr.address.startsWith('169.254.')) continue;
            const parts = addr.address.split('.');
            return `${parts[0]}.${parts[1]}.${parts[2]}`;
        }
    }
    return undefined;
}

/** Validate a subnet prefix string — three octets each 0-255 */
function isValidSubnetPrefix(prefix: string): boolean {
    const parts = prefix.split('.');
    if (parts.length !== 3) return false;
    return parts.every(p => {
        const n = Number(p);
        return /^\d+$/.test(p) && n >= 0 && n <= 255;
    });
}

/**
 * Scan an entire /24 subnet for hosts that have camera-related ports open.
 *
 * @param subnetPrefix  First three octets, e.g. "192.168.1".
 *                      If omitted, auto-detected from local network interfaces.
 */
export async function scanSubnet(subnetPrefix?: string): Promise<ScanResult[]> {
    const prefix = subnetPrefix ?? detectLocalSubnet();
    if (!prefix) return [];

    // Validate prefix — each octet must be 0–255
    if (!isValidSubnetPrefix(prefix)) return [];

    // Build scan tasks for .1 – .254
    const tasks = Array.from({ length: 254 }, (_, i) => {
        const ip = `${prefix}.${i + 1}`;
        return () => scanHost(ip);
    });

    const rawResults = await runInBatches(tasks);
    return rawResults.filter((r): r is ScanResult => r !== undefined);
}
