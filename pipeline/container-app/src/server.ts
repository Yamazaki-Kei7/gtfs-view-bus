import {
	createServer,
	type IncomingHttpHeaders,
	type IncomingMessage,
	type ServerResponse,
} from 'node:http';
import { Buffer } from 'node:buffer';
import { handleContainerRequest, type ContainerAppEnv } from './app';

const PORT = Number(process.env.PORT ?? '8080');

function env(): ContainerAppEnv {
	return {
		R2_BASE_URL: process.env.R2_BASE_URL ?? 'http://r2.internal',
	};
}

function headersFromIncoming(headers: IncomingHttpHeaders): Headers {
	const result = new Headers();
	for (const [key, value] of Object.entries(headers)) {
		if (value === undefined) continue;
		if (Array.isArray(value)) {
			result.set(key, value.join(', '));
			continue;
		}
		result.set(key, value);
	}
	return result;
}

async function requestBody(request: IncomingMessage): Promise<ArrayBuffer> {
	const chunks: Uint8Array[] = [];
	for await (const chunk of request) {
		if (typeof chunk === 'string') {
			chunks.push(new TextEncoder().encode(chunk));
		} else {
			chunks.push(new Uint8Array(chunk));
		}
	}
	const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
	const body = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		body.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength);
}

async function respond(req: IncomingMessage, res: ServerResponse): Promise<void> {
	const request = new Request(`http://localhost:${PORT}${req.url ?? '/'}`, {
		method: req.method ?? 'GET',
		headers: headersFromIncoming(req.headers),
		body: req.method === 'GET' || req.method === 'HEAD' ? undefined : await requestBody(req),
	});
	const response = await handleContainerRequest(request, env());
	res.statusCode = response.status;
	for (const [key, value] of response.headers) {
		res.setHeader(key, value);
	}
	res.end(Buffer.from(await response.arrayBuffer()));
}

createServer((req, res) => {
	void respond(req, res).catch((error: Error) => {
		console.error(error);
		if (!res.headersSent) {
			res.statusCode = 500;
		}
		res.end('internal server error');
	});
}).listen(PORT, () => {
	console.log(`Feed processor container listening on ${PORT}`);
});
