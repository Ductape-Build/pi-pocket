#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { closeSync, constants, mkdirSync, openSync, readFileSync, statSync } from "node:fs";
import { homedir, networkInterfaces } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import "../../bin/strip-types.js";

const { readRunning } = await import("../../src/launcher/desktop.ts");

const home = homedir();
const data = resolve(process.env.PI_POCKET_DIR || join(home, ".pi-pocket"));
const profile = join(
    process.env.XDG_DATA_HOME || join(home, ".local", "share"),
    "pi-pocket",
    "chromium",
);
const state = join(process.env.XDG_STATE_HOME || join(home, ".local", "state"), "pi-pocket");
const log = join(state, "desktop.log");
const launcher = fileURLToPath(new URL("../../bin/pi-pocket.js", import.meta.url));
const shutdown = new AbortController();

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.once(signal, () => shutdown.abort());
}

function isLocalAddress(host) {
    if (["localhost", "127.0.0.1", "[::1]"].includes(host)) {
        return true;
    }

    return Object.values(networkInterfaces())
        .flat()
        .some((entry) =>
            entry.family === "IPv6" ? `[${entry.address}]` === host : entry.address === host,
        );
}

async function runningServer() {
    const running = readRunning(data);

    if (!running || running.pid <= 0) {
        return;
    }

    try {
        if (statSync(`/proc/${running.pid}`).uid !== process.getuid()) {
            return;
        }
    } catch (error) {
        if (error.code === "ENOENT") {
            return;
        }

        throw error;
    }

    if (running.url === null) {
        throw new Error(
            "Pi Pocket is running on a Unix socket. Open its reverse proxy URL instead.",
        );
    }

    const url = new URL(running.url);

    if (url.protocol !== "http:" || url.username || url.password || !isLocalAddress(url.hostname)) {
        throw new Error("The running Pi Pocket server does not have a local HTTP address.");
    }

    try {
        const response = await request(url, "/api/pocket/info");

        if (response.ok && (await response.json()).name === "pi-pocket") {
            return url;
        }
    } catch (error) {
        shutdown.signal.throwIfAborted();

        if (!(
            error instanceof TypeError ||
            error instanceof SyntaxError ||
            error.name === "TimeoutError"
        )) {
            throw error;
        }
    }
}

function request(url, path, options) {
    return fetch(new URL(path, url), {
        ...options,
        redirect: "error",
        signal: AbortSignal.any([shutdown.signal, AbortSignal.timeout(2000)]),
    });
}

async function windowUrl(url) {
    const config = readFileSync(join(data, "config.json"), "utf8");
    let ownerToken;

    try {
        ownerToken = JSON.parse(config)?.ownerToken;
    } catch {
        throw new Error("Pi Pocket's config.json is not valid JSON.");
    }

    if (typeof ownerToken !== "string" || !ownerToken) {
        throw new Error("Pi Pocket's config.json has no owner token.");
    }

    const response = await request(url, "/api/sign-in-link", {
        method: "POST",
        headers: { Authorization: `Bearer ${ownerToken}`, "X-Pocket": "1" },
    });

    if (!response.ok) {
        throw new Error(`Pi Pocket refused desktop sign-in (HTTP ${response.status}).`);
    }

    const path = (await response.json().catch(() => null))?.path;

    if (typeof path !== "string" || !/^\/login\?once=[\w-]+$/.test(path)) {
        throw new Error("Pi Pocket returned an invalid one-time sign-in link.");
    }

    return new URL(path, url).href;
}

async function main() {
    mkdirSync(profile, { mode: 0o700, recursive: true });
    mkdirSync(state, { mode: 0o700, recursive: true });
    const output = openSync(
        log,
        constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY | constants.O_NOFOLLOW,
        0o600,
    );
    let server;
    let browser;

    try {
        let url = await runningServer();

        if (!url) {
            server = spawn(process.execPath, [launcher, "--desktop", "--data", data], {
                cwd: home,
                stdio: ["pipe", output, output],
            });
            server.stdin.on("error", () => {});
            let failure;
            let exitedAt;

            server.on("error", (error) => {
                failure = error;
            });
            server.on("exit", () => {
                exitedAt = Date.now();
            });
            const deadline = Date.now() + 60000;

            // Another launch may win the upstream data-folder lock. Give its server time to appear.
            while (!url && Date.now() < Math.min(deadline, (exitedAt ?? deadline) + 5000)) {
                if (failure) {
                    throw failure;
                }

                await sleep(250, undefined, { signal: shutdown.signal });
                url = await runningServer();
            }

            if (!url) {
                throw new Error(`Pi Pocket did not start. See ${log}.`);
            }
        }

        const target = await windowUrl(url);

        browser = spawn(
            "chromium",
            [
                `--user-data-dir=${profile}`,
                "--class=pi-pocket",
                "--disable-background-mode",
                "--no-first-run",
                "--no-proxy-server",
                `--app=${target}`,
            ],
            { stdio: "ignore" },
        );
        // Node's spawn error includes the argument list; never log the sign-in URL.
        const outcome = once(browser, "exit", { signal: shutdown.signal }).catch(() => {
            shutdown.signal.throwIfAborted();

            throw new Error("Could not start Chromium. Install chromium and try again.");
        });
        const [status] = await outcome;

        if (status !== 0) {
            throw new Error("The Chromium app window closed unexpectedly.");
        }
    } finally {
        if (browser && shutdown.signal.aborted) {
            browser.kill();
        }

        // Closing stdin stops only the --desktop launcher we spawned, not a reused server.
        server?.stdin.end();
        closeSync(output);
    }
}

try {
    await main();
} catch (error) {
    if (!shutdown.signal.aborted) {
        const message = error.message;

        console.error(`Pi Pocket: ${message}`);
        spawnSync("notify-send", ["--", "Pi Pocket", message], { stdio: "ignore" });
        process.exitCode = 1;
    }
}
