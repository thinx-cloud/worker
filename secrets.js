/**
 * Docker Secrets support for the build worker (SEC-CFG-01/02).
 *
 * A copy of the API's lib/thinx/secrets.js (thinx-device-api). Keep the two in
 * sync: the same precedence, cache and path containment.
 *
 * readSecret(name) resolves a credential by preferring a Docker secret file
 * (`/run/secrets/<name>`, as mounted by swarm) over `process.env[name]`, with
 * the env value as a fallback for plain `docker run -e ...` deployments. The
 * result is cached per name, so the filesystem is probed at most once.
 *
 * Depends only on `fs` and `path`.
 */

const fs = require("fs");
const path = require("path");

const SECRETS_DIR = "/run/secrets/";
const cache = {};

function readSecret(name, defaultValue) {
	if (typeof defaultValue === "undefined") defaultValue = null;
	if (Object.prototype.hasOwnProperty.call(cache, name)) return cache[name];

	let value = defaultValue;
	try {
		const base = path.resolve(SECRETS_DIR);
		const secret_path = path.resolve(base, name);
		const relative = path.relative(base, secret_path);
		if (relative.startsWith("..") || path.isAbsolute(relative)) {
			throw new Error("Invalid secret name");
		}
		if (fs.existsSync(secret_path)) {
			value = fs.readFileSync(secret_path, "utf8").trim();
		} else if (typeof process.env[name] !== "undefined") {
			value = process.env[name];
		}
	} catch (_e) {
		// secret file unreadable — fall back to env, else default
		if (typeof process.env[name] !== "undefined") value = process.env[name];
	}

	cache[name] = value;
	return value;
}

// Test seam: clear the per-name cache between cases.
function _resetCacheForTests() {
	for (const k in cache) delete cache[k];
}

module.exports = { readSecret, _resetCacheForTests };
