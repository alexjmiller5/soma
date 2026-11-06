# Push registration contract draft

Life Data owns registration, authorization, revocation and delivery retries.
Life UI owns platform callbacks and presentation. These proposed routes are not
implemented or advertised. The current client readiness gate remains false
until a canonical adapter receives a matching service confirmation. No signing,
provisioning, deployment, or existing local notification ID change is included.

## Authentication and identity

Reuse the existing authenticated device-session request seam. The service must
establish native-enrollment provenance from server-owned metadata; a token name,
client assertion, or broad `full` scope is not evidence of that provenance.
Existing token hashes stay private to the service. A server-issued opaque
`sessionBinding` identifies the enrolled credential to the client without
exposing its token/hash. Rotation or replacement creates a different binding.
Legacy credentials without established provenance do not advertise registration.

The service owns a stable `deploymentIdentity` and configured public app-profile
IDs. Each profile maps to a permitted platform, APNs topic and environment.
The authenticated enrollment must be allowed to use that profile. Clients send
the profile ID, never provider credentials, a topic, an environment, a deployment
ID, a principal, or somebody else's installation ID as authority.

The existing session response will advertise this optional capability only when
the complete implementation and permitted service profile are available:

```ts
type PushRegistrationCapability = {
  protocol: "apns-registration-v1";
  deploymentIdentity: string;
  sessionBinding: string;
  profiles: { id: string; platform: "ios" | "macos" }[];
};
// Proposed optional /v1/session capabilities.push_registration field.
```

Missing capability means unavailable. The advertised fields are service-owned
client facts, not Cloudflare/APNs infrastructure configuration. The authenticated
credential plus app profile identifies one installation subscription. Distinct
device enrollments get distinct installation IDs and delivery receipts.

## Routes and exact data shapes

```ts
type RegistrationState = {
  installationId: string;
  revision: string;
  state: "active" | "revoked";
  deploymentIdentity: string;
  sessionBinding: string;
  appProfile: string;
  activatedAfterSeq: number;
  updatedAt: string;
};
type RegisterPushRequest = {
  appProfile: string;
  deviceToken: string; // canonical lowercase hex of the opaque APNs token bytes
  expectedRevision: string | null; // null means no registration exists
  requestId: string; // opaque request/idempotency key, reused for this exact body
};
type RevokePushRequest = {
  appProfile: string;
  expectedRevision: string | null; // null creates a revoked barrier only if absent
  requestId: string;
};
type RegistrationReceipt = {
  requestId: string;
  registration: RegistrationState;
};
type RegistrationResult =
  | { kind: "confirmed"; receipt: RegistrationReceipt }
  | { kind: "conflict"; code: "registration_changed" | "request_reused" }
  | { kind: "unavailable" };
type RegistrationReadResult =
  | { kind: "available"; registration: RegistrationState | null }
  | { kind: "unavailable" };
```

| Route | Request | Response |
| --- | --- | --- |
| `GET /v1/push/registration?appProfile=<id>` | Current authenticated session and permitted profile | `RegistrationReadResult` |
| `POST /v1/push/registration` | `RegisterPushRequest` | `RegistrationResult` |
| `POST /v1/push/registration/revoke` | `RevokePushRequest` | `RegistrationResult` with revoked state on confirmation |

All responses are no-store. Token bytes are never returned, logged, placed in
event IDs, or exposed through the public feed. Token length is variable; accept
nonempty even lowercase hexadecimal within a service-defined request size bound,
not a hardcoded 32-byte token assumption. Unknown fields and invalid bodies fail
with HTTP 400; unauthorized sessions fail with HTTP 401. A forbidden profile or
unsupported enrollment returns unavailable without exposing another binding.
Conflict responses use HTTP 409; the future adapter parses the exact body.
Registration is atomic, but a lost or ambiguous response can follow a successful
commit. Reconcile the exact request key instead of assuming that it rolled back.

GET supplies a compare-and-swap baseline. It does not prove that the server has
the token from the current callback and cannot independently establish client
readiness. A current token must be registered or reconciled through its exact
POST request. After process restart, acquire the current revision and perform
that registration under the freshly captured session/token context.

The usage-cap wrapper must exempt exactly `GET /v1/push/registration`,
`POST /v1/push/registration` and `POST /v1/push/registration/revoke` by method
and path. These handlers access only the auth store and still enforce session
authorization and app-profile restrictions at the cap. This is not a prefix
exemption for `/v1/push/*`; other methods, unknown push routes and data routes
retain their existing cap behavior. Registration, rotation and revocation must
remain available when the data-store allowance is exhausted.

## Atomic registration and retry behavior

Registration and its request receipt commit together in the service's existing
auth store, alongside the session registry and notification feed. Guard the
current enrollment authorization and exact registration revision in that same
transaction. Omit unrelated data-store writes and schema/catalog changes.
The service chooses the installation ID and advances its opaque revision on a
successful state transition. A null precondition creates only if absent; it
never means unconditional overwrite. Revoked registrations retain a revision
so reactivation is explicit and guarded.

A null-precondition revoke atomically creates a revoked registration barrier
only if no registration exists; an existing row causes `registration_changed`.
If revoke wins against an in-flight null-precondition create, the late create
conflicts with that barrier. If create wins first, the still-current revoke
intent reads the resulting revision and submits a newly identified guarded
revoke. An absent GET alone never means revocation completed. Revocation is
confirmed only after its guarded revoked state commits. A revoked receipt
never changes the client intent back to registration; only a later explicit
register intent in a new generation may reactivate the subscription.

The request key binds the authenticated session, profile, route and exact body.
Different content under an existing key is `request_reused`. An exact retry does
not change the token, revision, activation cursor or delivery state a second
time. Reauthenticate and check current authorization before exposing its result.

Registration readiness differs from a historical write receipt: an old success
must not claim that an obsolete registration is still active. A replay returns
confirmed only while its recorded resulting revision is still current. After
rotation, revocation or replacement it returns `registration_changed`; it never
reinstates the old token. An uncertain response retains the exact request/key.
After a definitive revision conflict, the current client generation may read
the new revision and submit a newly identified request for its current token.
An obsolete generation must not refetch a revision and overwrite newer state.

The service captures the activation feed sequence atomically. New subscriptions
begin with future events after that sequence, without replaying the historical
inbox as push banners. Token rotation preserves the subscription's existing
delivery cursor and event identity. Reactivation after explicit revocation uses
a fresh future-event boundary. Read acknowledgments do not count as delivery.

## Client generation and readiness boundary

The root app owns one registration lifecycle using its existing session storage;
there is no second registration or retry database. An in-memory generation
changes on token rotation, logout, session replacement, deployment replacement,
selected app-profile replacement, or explicit revoke intent. Revoke intent
increments the generation and clears readiness before any GET or POST, and
invalidates pending token-registration callbacks and retries. Capture that
generation, registration/revocation intent and complete
context before a request; recheck it before dispatch, conflict retry, and result
acceptance. A callback alone, OS permission, GET state, or attempted registration
never makes `NotificationAlerts.isPushRegistered(endpoint)` true.

Readiness requires a confirmed active receipt whose request ID matches the
request sent with the current token, whose service deployment/session/profile
matches the current authenticated capability, and whose captured generation is
still current. Keep installation/revision from that receipt in the existing
runtime session owner. Logout or any context change immediately makes readiness
false and discards stale responses. One installation's receipt cannot authorize
another installation. Failure or revoked confirmation remains false.

Generation checks apply to original responses as well as idempotent retries.
If an active registration commits, a later revoke commits and returns, and the
original active success then arrives, that success belongs to the obsolete
registration generation and cannot restore readiness. A response already issued
by the service cannot be invalidated by a later server-side receipt check.

Once ready, APNs owns native banners and polling updates inbox/read state only.
Check readiness again after suspension points before local scheduling. Preserve
the current foreground local-alert behavior until confirmation. Permission
requests remain explicit user actions. Already submitted OS/APNs notifications
cannot be guaranteed recalled during a transition; provider acceptance is not
proof of a displayed banner or exactly-once presentation.

## Delivery identity and revocation

The collapse key remains exactly 43 ASCII bytes:

```js
base64urlWithoutPadding(SHA256(utf8(JSON.stringify([
  "life-notification-v1", deploymentIdentity, exactEventId
]))))
```

Use ECMAScript JSON escaping without slash escaping, whitespace or Unicode
normalization. Inputs are Unicode scalar strings. Token, profile, environment,
installation and registration revision are excluded. The single cross-language
golden-vector source is Life UI's
`packages/LifeKit/Tests/LifeKitTests/NotificationDeliveryIdentityTests.swift`.
Current local notification identifiers/checkpoints are unchanged.

Durable delivery attempts and retries are per installation plus original event
ID, separate from deployment-wide read state. Check live session authorization
and the current registration generation before dispatching an unsent delivery.
Token/session revocation disables future sends for that binding; token rotation
does not acknowledge outstanding events or another installation's deliveries.
An invalid-token response for an older delivery generation cannot revoke a
newer registration; provider-result updates require that captured revision.
Provider acceptance, retryable rejection, permanent invalid-token responses,
presentation and user read state are distinct facts.

## Required service acceptance

- Authenticated installation/profile isolation; forged identity/topic/environment
  fields rejected; operator/agent tokens cannot acquire native provenance by name.
- Null/create and exact-revision updates race safely; old token requests arriving
  after a newer commit conflict; same-key retries do not reinstall obsolete state.
- Token rotation, logout, session/deployment/profile replacement and late responses
  satisfy the client generation matrix; two installations remain independent.
- Explicit revoke invalidates pending callbacks before network work. Exercise
  both first-create/revoke commit orders and the delayed original active response
  after a revoked confirmation; none can restore readiness or reactivate from
  the obsolete generation.
- A POST lost after commit can reconcile its exact key while current, but an old
  receipt after revoke/rotation never reports current readiness.
- Auth revocation and registration mutation guard the same auth-store transaction;
  tokens stay out of responses, logs and notification payloads. Tests use only
  synthetic tokens.
- At the data usage cap, valid enrollment/profile registration, rotation and
  revocation succeed without data-store access. Authentication and profile
  isolation still deny invalid requests. Other methods, unrelated push routes
  and ordinary data routes do not acquire a new exemption.
- Registration cutover and per-installation retries preserve event ID/sequence and
  never mark shared inbox items read as a side effect of attempted delivery.

Canonical DTO generation, service implementation/auth tests, and capability
advertisement precede any HTTP adapter. App hooks and signing remain root-owned.
