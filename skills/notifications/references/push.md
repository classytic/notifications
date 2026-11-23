# Push transports (`@classytic/notifications/push`)

FCM HTTP v1 and APNs HTTP/2 with node built-ins only (`node:crypto`, `node:http2`, `fetch`). Every export is a `PushProvider`, so it plugs into `PushChannel`.

```ts
import { PushChannel } from '@classytic/notifications/channels';
import { apnsProvider, fcmProvider, pushRouter } from '@classytic/notifications/push';

const dropToken = (token: string) => devices.deleteOne({ token });
const provider = pushRouter({
  android: fcmProvider({ credentials: () => fcmCreds, onInvalidToken: dropToken }),
  ios: apnsProvider({ credentials: () => apnsCreds, onInvalidToken: dropToken }),
});
const push = new PushChannel({ provider });
// send with data.platform: 'android' | 'ios'
```

## Credentials

| Provider | Shape |
|---|---|
| `fcmProvider` | `FcmCredentials`: `projectId`, `clientEmail`, `privateKey` (RSA PEM), optional `privateKeyId`, `tokenUri`, `version`. `parseFcmServiceAccount` accepts the downloaded JSON, its text or its base64 |
| `apnsProvider` | `ApnsCredentials`: `keyId`, `teamId`, `privateKey` (.p8 PEM), `bundleId`, `environment` (`production` default, `sandbox`), optional `version` |

- `credentials` is a value or a function, called on every send. Return a cached object. A changed `version` (or any changed field) re-imports the key and drops cached tokens: rotation without restart.
- Providers never read `process.env`. Errors name fields, never values.
- FCM: OAuth2 token from a service-account JWT (RS256), cached until 60 s before expiry, one shared refresh for concurrent sends.
- APNs: ES256 provider token reused for 50 min (`tokenTtlMs`, 20 to 60 min), one HTTP/2 session per host, reconnect after GOAWAY.

## Message fields (`PushProviderMessage`)

`token`, `title`, `body`, `data` (strings), `imageUrl`, `collapseKey` (64 bytes max), `threadId`, `badge`, `platform`, `priority`, `ttlSeconds`, `interruptionLevel` (`passive`, `active`, `time-sensitive`, `critical`), `contentAvailable` (data-only), `sound` (`null` silent), `channelId`, `category`. `PushChannel` reads each from `payload.data`; a data-only push needs `data.contentAvailable: true` or `data.dataOnly: true`.

`critical` becomes `time-sensitive` unless `allowCriticalAlerts: true` (the iOS build has Apple's entitlement).

## Errors

| Error | When | Retried |
|---|---|---|
| `InvalidPushTokenError` (`reason`: `unregistered`, `invalid-token`, `bad-device-token`) | FCM UNREGISTERED / INVALID_ARGUMENT naming the token; APNs 410, BadDeviceToken. `onInvalidToken(token, reason)` runs first | no |
| `PushRejectedError` | payload rejected, SENDER_ID_MISMATCH, DeviceTokenNotForTopic, platform with no provider | no |
| `PushCredentialsError` | credentials missing, malformed, or refused twice | no |
| `TransientPushError` (`retryAfterMs`) | 429, 5xx, timeout, network | yes, never sooner than `Retry-After` |

A provider-wide 429 / 503 with `Retry-After` pauses that provider instance until the time passes (fails fast meanwhile). A per-device 429 does not.

## Content-free pushes

`createContentFreeBuilder({ allowedKeys, types })` builds `{ title, body: '', data: { type, ...ids } }` and refuses other keys or non-id values. `contentFreeOnly(provider, options)` enforces the same at the transport.

## Observability

`onDelivery(event)` receives one `PushDeliveryEvent` per send: `outcome`, `status`, `reason`, `tokenSuffix`, `tokenHash`, `latencyMs`. No token, no title, no body.
