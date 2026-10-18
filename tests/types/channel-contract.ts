/**
 * Type-level contract (compiled by `npm run typecheck`, never executed):
 * every exported channel is assignable to `Channel` under the strictest
 * consumer settings (`exactOptionalPropertyTypes`, see tsconfig.types.json),
 * resolved through the package's own exports (the built `.d.mts`), exactly as a
 * host sees them.
 */
import type { Channel } from '@classytic/notifications';
import {
  BaseChannel,
  ConsoleChannel,
  EmailChannel,
  PushChannel,
  SmsChannel,
  TelegramChannel,
  WebhookChannel,
} from '@classytic/notifications/channels';

type Assert<T extends true> = T;
type IsChannel<C> = C extends Channel ? true : false;

export type Contract = [
  Assert<IsChannel<BaseChannel>>,
  Assert<IsChannel<ConsoleChannel>>,
  Assert<IsChannel<EmailChannel>>,
  Assert<IsChannel<PushChannel>>,
  Assert<IsChannel<SmsChannel>>,
  Assert<IsChannel<TelegramChannel>>,
  Assert<IsChannel<WebhookChannel>>,
];

// The real call sites: a constructed channel goes into `Channel[]` without a cast.
declare const push: PushChannel;
declare const email: EmailChannel;
export const channels: Channel[] = [push, email];
