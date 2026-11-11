// Types for vite-plugin-pwa's register module. Its own `vite-plugin-pwa/client`
// types aren't resolvable here (pnpm doesn't hoist the transitive dependency).
declare module 'virtual:pwa-register' {
	export interface RegisterSWOptions {
		immediate?: boolean;
		onNeedRefresh?: () => void;
		onOfflineReady?: () => void;
		onRegisteredSW?: (
			swScriptUrl: string,
			registration: ServiceWorkerRegistration | undefined
		) => void;
		onRegisterError?: (error: unknown) => void;
	}

	/** Registers the service worker; the returned function activates a waiting update (and reloads when passed true). */
	export function registerSW(options?: RegisterSWOptions): (reloadPage?: boolean) => Promise<void>;
}
