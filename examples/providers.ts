/**
 * Copy-pasteable provider adapters for common services.
 *
 * These are NOT bundled in the package — they're examples.
 * Copy the ones you need into your project.
 */

import type { SmsProvider, PushProvider } from '@classytic/notifications';

// ============================================================================
// SMS Providers
// ============================================================================

/**
 * Twilio SMS adapter
 * Install: npm install twilio
 */
export function createTwilioSmsProvider(config: {
  accountSid: string;
  authToken: string;
}): SmsProvider {
  // Lazy import to avoid requiring twilio at module load
  let client: any = null;

  return {
    async send({ to, from, body }) {
      if (!client) {
        const twilio = await import('twilio');
        client = (twilio.default ?? twilio)(config.accountSid, config.authToken);
      }
      const msg = await client.messages.create({ to, from, body });
      return { sid: msg.sid };
    },
  };
}

/**
 * AWS SNS SMS adapter
 * Install: npm install @aws-sdk/client-sns
 */
export function createSnsSmsProvider(config?: {
  region?: string;
}): SmsProvider {
  let snsClient: any = null;

  return {
    async send({ to, body }) {
      if (!snsClient) {
        const { SNSClient, PublishCommand } = await import('@aws-sdk/client-sns');
        snsClient = { client: new SNSClient({ region: config?.region ?? 'us-east-1' }), PublishCommand };
      }
      const res = await snsClient.client.send(
        new snsClient.PublishCommand({
          PhoneNumber: to,
          Message: body,
        }),
      );
      return { sid: res.MessageId ?? '' };
    },
  };
}

/**
 * Vonage (Nexmo) SMS adapter
 * Install: npm install @vonage/server-sdk
 */
export function createVonageSmsProvider(config: {
  apiKey: string;
  apiSecret: string;
}): SmsProvider {
  let vonage: any = null;

  return {
    async send({ to, from, body }) {
      if (!vonage) {
        const { Vonage } = await import('@vonage/server-sdk');
        vonage = new Vonage({ apiKey: config.apiKey, apiSecret: config.apiSecret } as any);
      }
      const res = await vonage.sms.send({ to, from, text: body });
      return { sid: res.messages?.[0]?.['message-id'] ?? '' };
    },
  };
}

// ============================================================================
// Push Notification Providers
// ============================================================================

/**
 * Firebase Cloud Messaging (FCM) adapter
 * Install: npm install firebase-admin
 */
export function createFcmPushProvider(config: {
  projectId: string;
  credential: Record<string, unknown>;
}): PushProvider {
  let messaging: any = null;

  return {
    async send({ token, title, body, data, imageUrl }) {
      if (!messaging) {
        const admin = await import('firebase-admin');
        const mod = (admin as any).default ?? admin;
        const app = mod.apps?.length
          ? mod.app()
          : mod.initializeApp({
            projectId: config.projectId,
            credential: mod.credential.cert(config.credential),
          });
        messaging = app.messaging();
      }
      const result = await messaging.send({
        token,
        notification: { title, body, ...(imageUrl ? { imageUrl } : {}) },
        data,
      });
      return { messageId: result };
    },
  };
}

/**
 * Expo Push adapter
 * Install: npm install expo-server-sdk
 */
export function createExpoPushProvider(): PushProvider {
  let expo: any = null;

  return {
    async send({ token, title, body, data }) {
      if (!expo) {
        const { Expo } = await import('expo-server-sdk');
        expo = new Expo();
      }
      const receipts = await expo.sendPushNotificationsAsync([
        { to: token, title, body, data },
      ]);
      return { messageId: receipts[0]?.id ?? '' };
    },
  };
}

/**
 * OneSignal Push adapter (REST API)
 * No extra dependency needed — uses native fetch.
 */
export function createOneSignalPushProvider(config: {
  appId: string;
  apiKey: string;
}): PushProvider {
  return {
    async send({ token, title, body, data }) {
      const res = await fetch('https://onesignal.com/api/v1/notifications', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Basic ${config.apiKey}`,
        },
        body: JSON.stringify({
          app_id: config.appId,
          include_player_ids: [token],
          headings: { en: title },
          contents: { en: body },
          data,
        }),
      });
      const json = await res.json() as { id: string };
      return { messageId: json.id };
    },
  };
}

// ============================================================================
// Status Webhook Mappers
// ============================================================================

import type { DeliveryStatus } from '@classytic/notifications';

/** Map Twilio message status to normalized status */
export function mapTwilioStatus(twilioStatus: string): DeliveryStatus {
  const map: Record<string, DeliveryStatus> = {
    queued: 'queued',
    accepted: 'accepted',
    sending: 'sent',
    sent: 'sent',
    delivered: 'delivered',
    undelivered: 'undelivered',
    failed: 'undelivered',
    receiving: 'delivered',
    received: 'delivered',
  };
  return map[twilioStatus] ?? 'sent';
}

/** Map AWS SES notification type to normalized status */
export function mapSesStatus(sesNotificationType: string): DeliveryStatus {
  const map: Record<string, DeliveryStatus> = {
    Delivery: 'delivered',
    Bounce: 'bounced',
    Complaint: 'complained',
    Send: 'sent',
    Reject: 'undelivered',
    Open: 'opened',
    Click: 'clicked',
  };
  return map[sesNotificationType] ?? 'sent';
}

/** Map SendGrid event type to normalized status */
export function mapSendGridStatus(sendGridEvent: string): DeliveryStatus {
  const map: Record<string, DeliveryStatus> = {
    processed: 'accepted',
    dropped: 'undelivered',
    delivered: 'delivered',
    deferred: 'queued',
    bounce: 'bounced',
    open: 'opened',
    click: 'clicked',
    spamreport: 'complained',
    unsubscribe: 'unsubscribed',
  };
  return map[sendGridEvent] ?? 'sent';
}

// ============================================================================
// Usage Example: Full setup with fallback + status tracking
// ============================================================================

/*
import { NotificationService } from '@classytic/notifications';
import { EmailChannel, SmsChannel, PushChannel } from '@classytic/notifications/channels';
import {
  MemoryDeliveryLog, MemoryQueue, createSimpleResolver,
  withFallback, createStatusHandler,
} from '@classytic/notifications/utils';

// 1. Create providers
const smsProvider = createTwilioSmsProvider({
  accountSid: process.env.TWILIO_SID!,
  authToken: process.env.TWILIO_TOKEN!,
});

const pushProvider = createFcmPushProvider({
  projectId: process.env.FCM_PROJECT!,
  credential: JSON.parse(process.env.FCM_CREDENTIAL!),
});

// 2. Create service
const log = new MemoryDeliveryLog();
const service = new NotificationService({
  channels: [
    new PushChannel({ provider: pushProvider }),
    new SmsChannel({ from: '+15551234567', provider: smsProvider }),
    new EmailChannel({
      from: 'noreply@app.com',
      transport: { service: 'gmail', auth: { user: '...', pass: '...' } },
      rateLimit: { maxPerWindow: 500, windowMs: 86_400_000 },
    }),
  ],
  templates: createSimpleResolver({
    otp: { subject: 'Your code: ${code}', text: 'Your verification code is ${code}' },
  }),
  deliveryLog: log,
  queue: new MemoryQueue(),
});

// 3. Channel fallback: try push -> sms -> email
const result = await withFallback(
  service,
  {
    event: 'auth.otp',
    recipient: { id: 'u1', email: 'user@example.com', phone: '+15559876543', deviceToken: 'fcm-token' },
    data: { code: '1234' },
    template: 'otp',
  },
  ['push', 'sms', 'email'],
  {
    onFallback: (failed, error, next) => {
      console.log(`${failed} failed (${error}), trying ${next}`);
    },
  },
);

// 4. Status webhook handler
const statusHandler = createStatusHandler({
  onStatusChange: (update) => {
    console.log(`[${update.provider}] ${update.notificationId}: ${update.status}`);
  },
});

// In your Express route:
// app.post('/webhooks/twilio', (req, res) => {
//   statusHandler.handle({
//     provider: 'twilio',
//     notificationId: req.body.MessageSid,
//     channel: 'sms',
//     status: mapTwilioStatus(req.body.MessageStatus),
//     rawPayload: req.body,
//     timestamp: new Date(),
//   });
//   res.sendStatus(200);
// });

// 5. Delayed/scheduled delivery (requires queue adapter)
await service.send({
  event: 'reminder.appointment',
  recipient: { email: 'user@example.com' },
  data: { subject: 'Appointment tomorrow', text: 'Don\'t forget!' },
  delay: 3_600_000, // send in 1 hour
});
*/
