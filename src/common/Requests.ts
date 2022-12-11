import { Messaging } from '@common/Messaging';
import { RequestError } from '@common/RequestError';
import { Shared } from '@common/Shared';
import browser from 'webextension-polyfill';

export type RequestDetails = {
	url: string;
	method: string;
	headers?: Record<string, string>;
	body?: unknown;
	signal?: AbortSignal;
	cancelKey?: string;
	rateLimit?: RateLimit;
	priority?: RequestPriority;
	withHeaders?: Record<string, string>;
	withRateLimit?: RateLimitConfig;
};

export interface RequestOptions {
	method: RequestInit['method'];
	headers: Record<string, string>;
	body: RequestInit['body'];
}

export interface RateLimit {
	id: string;
	maxRPS: number;
}

export enum RequestPriority {
	NORMAL,
	HIGH,
}

export interface RateLimitConfig {
	/** All requests with the same ID will be limited by the same instance. */
	id: string;

	/** Maximum requests per second. */
	maxRPS: {
		/** This limit will apply to all methods, unless a limit for the specific method has been provided. */
		'*': number;

		/** This limit will apply to the specific method. */
		[K: string]: number | undefined;
	};
}

class _Requests {
	readonly withHeaders: Record<string, string> = {};
	readonly withRateLimit: RateLimitConfig = {
		id: 'default',
		maxRPS: {
			'*': 2,
		},
	};

	async send(request: RequestDetails, tabId = Shared.tabId): Promise<string> {
		let responseText = '';
		if (Shared.pageType === 'background') {
			responseText = await this.sendDirectly(request, tabId);
		} else {
			// All requests from other pages must be sent to the background page so that it can rate limit them
			request.withHeaders = this.withHeaders;
			request.withRateLimit = this.withRateLimit;
			responseText = await Messaging.toExtension({ action: 'send-request', request });
		}
		return responseText;
	}

	async sendDirectly(request: RequestDetails, tabId = Shared.tabId): Promise<string> {
		let responseStatus = 0;
		let responseText = '';
		try {
			const response = await this.fetch(request, tabId);
			responseStatus = response.status;
			responseText = await response.text();
			if (responseStatus < 200 || responseStatus >= 400) {
				throw responseText;
			}
		} catch (err) {
			throw new RequestError({
				request,
				status: responseStatus,
				text: responseText,
				isCanceled: request.signal?.aborted ?? false,
			});
		}
		return responseText;
	}

	async fetch(request: RequestDetails, tabId = Shared.tabId): Promise<Response> {
		const options = await this.getOptions(request, tabId);

		return fetch(request.url, {
			method: options.method,
			headers: options.headers,
			body: options.body,
			signal: request.signal,
		});
	}

	async getOptions(request: RequestDetails, tabId = Shared.tabId): Promise<RequestOptions> {
		return {
			method: request.method,
			headers: await this.getHeaders(request, tabId),
			body: typeof request.body === 'string' ? request.body : JSON.stringify(request.body),
		};
	}

	async getHeaders(request: RequestDetails, tabId = Shared.tabId): Promise<Record<string, string>> {
		const headers: Record<string, string> = {
			...this.withHeaders,
			...(request.withHeaders || {}),
			'Content-Type':
				typeof request.body === 'string' ? 'application/x-www-form-urlencoded' : 'application/json',
			...(request.headers || {}),
		};
		const cookies = await this.getCookies(request, tabId);
		if (cookies) {
			headers['UTS-Cookie'] = cookies;
		}
		return headers;
	}

	async getCookies(request: RequestDetails, tabId = Shared.tabId): Promise<string | undefined> {
		if (tabId === null) {
			return;
		}
		if (!Shared.storage.options.grantCookies || !browser.cookies || !browser.webRequest) {
			return;
		}
		const domainMatches = /https?:\/\/(?:www\.)?(?<domain>.+?)(?:\/.*)?$/.exec(request.url);
		if (!domainMatches?.groups) {
			return;
		}
		const { domain } = domainMatches.groups;
		const tab = await browser.tabs.get(tabId);
		const cookies = await browser.cookies.getAll({
			domain,
			storeId: tab.cookieStoreId,
		});
		return cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');
	}

	getRateLimit(request: RequestDetails) {
		let id;
		let maxRPS;

		if (request.withRateLimit) {
			id = request.withRateLimit.id;
			maxRPS = request.withRateLimit.maxRPS[request.method];

			if (maxRPS) {
				return {
					id: `${id}_${request.method}`,
					maxRPS,
				};
			}

			maxRPS = request.withRateLimit.maxRPS['*'];

			return { id, maxRPS };
		}

		id = this.withRateLimit.id;
		maxRPS = this.withRateLimit.maxRPS[request.method];

		if (maxRPS) {
			return {
				id: `${id}_${request.method}`,
				maxRPS,
			};
		}

		maxRPS = this.withRateLimit.maxRPS['*'];

		return { id, maxRPS };
	}
}

export const Requests = new _Requests();

/**
 * Creates a proxy to a requests instance that uses the provided headers. Useful for making authenticated requests without having to provide the authentication headers every time.
 */
export const withHeaders = (headers: Record<string, string>, instance = Requests) => {
	return new Proxy(instance, {
		get: (target, prop, receiver) => {
			if (prop === 'withHeaders') {
				return { ...instance.withHeaders, ...headers };
			}
			return Reflect.get(target, prop, receiver) as unknown;
		},
	});
};

/**
 * Creates a proxy to a requests instance that uses the provided rate limit. Useful for making requests without having to provide the rate limit every time.
 */
export const withRateLimit = (rateLimit: RateLimitConfig, instance = Requests) => {
	return new Proxy(instance, {
		get: (target, prop, receiver) => {
			if (prop === 'withRateLimit') {
				return { ...instance.withRateLimit, ...rateLimit };
			}
			return Reflect.get(target, prop, receiver) as unknown;
		},
	});
};
