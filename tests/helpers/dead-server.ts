import { createServer, type Server } from "node:http";

/**
 * Creates a local HTTP server that immediately returns 404 Not Found.
 *
 * Windows TCP stack retries SYN to closed localhost ports (~2s per attempt),
 * and HTTP 5xx errors trigger retry logic with exponential backoff in
 * src/core/fetcher.ts (3 attempts × 1s-2s delays). 404 is a non-retryable
 * error (per isRecoverable in src/core/errors.ts) that still produces the
 * expected "endpoint unreachable" test outcome (initialSyncSuccess === false,
 * warned not thrown).
 *
 * Returns the server instance and its URL. Caller must close the server when done.
 */
export function createDeadServer(): Promise<{ server: Server; url: string }> {
	return new Promise((resolve) => {
		const server = createServer((_req, res) => {
			res.writeHead(404, { "Content-Type": "text/plain" });
			res.end("Not Found\n");
		});

		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			if (!address || typeof address === "string") {
				throw new Error("Server did not bind to a port");
			}

			const url = `http://127.0.0.1:${address.port}`;
			resolve({ server, url });
		});
	});
}
