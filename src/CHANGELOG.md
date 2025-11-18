# Changelog

## [1.0.0] - 2024-11-17

### Initial Release

**Core Features:**
- Multi-channel notification system
- Event-driven architecture
- Framework-agnostic design
- Zero dependencies
- ~200 lines of core code

**Components:**
- `NotificationChannel` - Base class for channels
- `createDispatcher` - Event routing
- `createNotificationHandlers` - Factory for handlers
- `mergeHooks` - Hook merging utility

**Features:**
- Event whitelisting per channel (spam prevention)
- Parallel execution across channels
- Error isolation (one channel failure doesn't affect others)
- Fire-and-forget pattern
- Easy to extend with custom channels

**Tested:**
- 10 integration tests
- All passing
- Coverage for core functionality

**Documentation:**
- Complete README with examples
- Channel examples (Email, Push, Slack)
- Framework integration guides
- API reference

**Design Patterns:**
- Abstract Factory
- Strategy
- Chain of Responsibility
- Observer
- Mediator

**Compatibility:**
- Node.js >= 18.0.0
- ES Modules only
- Works with Express, Fastify, NestJS, Next.js

