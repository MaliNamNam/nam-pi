// Plain JS bootstrap: the worker uses the running Pi package, not an extension's
// potentially stale peer dependency. Jiti handles user TypeScript extensions.
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { parentPort, workerData } from "node:worker_threads";
try {
	const require = createRequire(workerData.sdkEntry);
	const { createJiti } = require("jiti");
	const jiti = createJiti(import.meta.url, { interopDefault: true, alias: { "@earendil-works/pi-coding-agent": workerData.sdkEntry } });
	const { serveSDKWorker } = await jiti.import(fileURLToPath(new URL("./sdk-host.ts", import.meta.url)));
	await serveSDKWorker(parentPort);
} catch (error) {
	parentPort.postMessage({ type: "boot_error", error: String(error) });
	parentPort.close();
}
