import { Container, type OutboundHandler } from '@cloudflare/containers';
import { createR2OutboundHandler, R2_OUTBOUND_HOST } from './r2Outbound';

const r2Handler: OutboundHandler<Env> = async (request, env) =>
	createR2OutboundHandler(env.DATA_BUCKET)(request);

export class FeedProcessorContainer extends Container<Env> {
	defaultPort = 8080;
	sleepAfter = '2m';
	envVars = {
		R2_BASE_URL: `http://${R2_OUTBOUND_HOST}`,
	};
}

FeedProcessorContainer.outboundByHost = {
	[R2_OUTBOUND_HOST]: r2Handler,
};
