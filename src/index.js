import { DurableObject } from 'cloudflare:workers';

async function handleErrors(request, func) {
	try {
		return await func();
	} catch (err) {
		if (request.headers.get('Upgrade') == 'websocket') {
			const pair = new WebSocketPair();
			pair[1].accept();
			pair[1].send(JSON.stringify({ error: err.stack }));
			pair[1].close(1011, 'Uncaught exception during session setup');
			return new Response(null, { status: 101, webSocket: pair[0] });
		} else {
			return new Response(err.stack, { status: 500 });
		}
	}
}
export class Veet extends DurableObject {
	constructor(ctx, env) {
		super(ctx, env);
		this.ctx = ctx;
		this.storage = ctx.storage;
		this.env = env;

		this.sessions = new Map();
		this.ctx.getWebSockets().forEach((ws) => {
			const meta = ws.deserializeAttachment();
			this.sessions.set(ws, { ...meta });
		});
	}

	async fetch(request) {
		return await handleErrors(request, async () => {
			const pair = new WebSocketPair();
			await this.handleSession(pair[1]);
			return new Response(null, { status: 101, webSocket: pair[0] });
		});
	}

	async handleSession(ws) {
		this.ctx.acceptWebSocket(ws);

		this.sessions.set(ws, {});
	}

	async webSocketMessage(ws, msg) {
		try {
			const session = this.sessions.get(ws);
			if (session.quit) {
				ws.close(1011, 'websocket broken');
				return;
			}
			if (!session.id) {
				session.id = JSON.parse(msg).id;
				ws.serializeAttachment({ ...ws.deserializeAttachment(), id: session.id });
				// this.broadcast(ws, { type: 'joined', joined: session.id });
				ws.send(JSON.stringify({ ready: true }));
			}

			this.broadcast(ws, msg);
		} catch (error) {
			ws.send(JSON.stringify({ error: error.stack }));
		}
	}

	broadcast(senderWs, msg) {
		const leavers = [];
		this.sessions.forEach((session, ws) => {
			try {
				if (ws !== senderWs) {
					ws.send(typeof msg === 'string' ? msg : JSON.stringify(msg));
				}
			} catch (error) {
				leavers.push(session);
				session.quit = true;
				this.sessions.delete(ws);
			}
		});

		leavers.forEach((leaver) => {
			if (leaver.id) {
				this.broadcast(senderWs, { type: 'left', id: leaver.id });
			}
		});
	}

	async closeOrErrorHandler(ws) {
		let session = this.sessions.get(ws) || {};
		session.quit = true;
		this.sessions.delete(ws);

		if (session.id) {
			this.broadcast(ws, { type: 'left', id: session.id });
		}
	}

	async webSocketClose(ws) {
		this.closeOrErrorHandler(ws);
	}

	async webSocketError(ws) {
		this.closeOrErrorHandler(ws);
	}
}

export default {
	async fetch(request, env, ctx) {
		return await handleErrors(request, async () => {
			let id = env.VEET.idFromName(new URL(request.url).pathname);
			// let id = env.VEET.idFromName('veet');
			let stub = env.VEET.get(id);
			return stub.fetch(request);
		});
	},
};
