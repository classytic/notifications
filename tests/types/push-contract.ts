/**
 * Type-level contract for `@classytic/notifications/push` (compiled by `npm run typecheck`, never
 * executed), resolved through the built `.d.mts` under `exactOptionalPropertyTypes`, as a host
 * sees it: every provider is a root `PushProvider`, so it plugs into `PushChannel` unchanged, and
 * a pre-2.9 custom provider (narrow message type, no `close`) still type-checks.
 */
import type { PushProvider, PushProviderMessage } from '@classytic/notifications';
import { PushChannel } from '@classytic/notifications/channels';
import {
  apnsProvider,
  type ApnsCredentials,
  type CredentialsSource,
  type FcmCredentials,
  fcmProvider,
  pushRouter,
  contentFreeOnly,
} from '@classytic/notifications/push';

declare const fcmCreds: CredentialsSource<FcmCredentials>;
declare const apnsCreds: () => Promise<ApnsCredentials>;

const android: PushProvider = fcmProvider({ credentials: fcmCreds, onInvalidToken: async () => undefined });
const ios: PushProvider = apnsProvider({ credentials: apnsCreds, allowCriticalAlerts: true });
const router = pushRouter({ android, ios });
export const channel = new PushChannel({ provider: contentFreeOnly(router, { allowedKeys: ['id'] }) });

// A provider written against the 2.8 inline message type keeps compiling.
export const legacy: PushProvider = {
  send: async (m: { token: string; title: string; body: string }) => ({ messageId: m.token }),
};

// Every hint is optional.
export const minimal: PushProviderMessage = { token: 't', title: '', body: '' };
