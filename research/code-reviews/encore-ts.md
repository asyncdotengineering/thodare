# Encore.ts — deep code review

**Repo:** `encoredev/encore` (cloned shallow into `/Users/mithushancj/Documents/asyncdot/openscoped/agent-control-panel/encore`)
**Lens:** What can Thodare's `World` / Ports-and-Adapters layer steal from Encore.ts's "infrastructure-as-code embedded in your application code" pattern, its multi-cloud build story, and its parser-driven codegen pipeline? Where does Encore's CLI surface compare unfavorably to Flue's three-verb discipline, and what should Thodare deliberately *not* lift?

This is research only. No code changes.

---

## 1. Repo map — where the TS runtime lives

The Encore tree is **polyglot by design**: Go for the daemon/CLI, Rust for the parser and runtime, TypeScript for the user-facing SDK. The TS runtime is *not* a single tree — it's split across four cooperating components:

- **`runtimes/js/encore.dev/`** — the user-facing TypeScript SDK package (`encore.dev` on npm), MPL-2.0 (`runtimes/js/encore.dev/LICENSE:1`). This is what users `import` from. Pure `.ts`, no compiled JS in the source tree. Entry point `runtimes/js/encore.dev/mod.ts:1` re-exports `appMeta`, `currentRequest`, etc., and the per-primitive subpaths (`encore.dev/api`, `encore.dev/pubsub`, `encore.dev/storage/sqldb`, …) are declared as separate package exports in `runtimes/js/encore.dev/package.json:24-115`.
- **`runtimes/js/src/`** — the **N-API Rust addon** (Cargo crate `encore-runtime-js`) that backs the SDK. Files include `api.rs`, `pubsub.rs`, `sqldb.rs`, `objects.rs`, `secret.rs`, `cache.rs`, `gateway.rs`, `runtime.rs`, `runtime_config.rs`, `meta.rs`, etc. (`runtimes/js/src/lib.rs:1`). Every TS primitive object holds an `impl: runtime.X` pointer to a Rust resource managed by this addon.
- **`runtimes/core/src/`** — the **shared Rust runtime core** (Cargo crate `encore-runtime-core`) reused by both the JS and Go runtimes. This is where the *cloud adapters* live: `pubsub/{gcp,sqs_sns,nsq,noop}/`, `objects/{gcs,s3,noop}/`, `cache/{client.rs,miniredis.rs}`, `sqldb/`, `secrets/`, `trace/`, `metrics/`. The dispatch happens in e.g. `runtimes/core/src/pubsub/manager.rs:689-710`.
- **`tsparser/src/`** — the **Rust SWC-based static analysis pipeline** that walks user TS source, recognises Encore primitive declarations, and emits both metadata + a `encore.gen/` codegen tree. This is the heart of "infra-as-code" magic. Files: `parser/resources/infra/{pubsub_topic.rs,pubsub_subscription.rs,sqldb.rs,objects.rs,secret.rs,cron.rs,cache.rs,metrics.rs}`, `parser/resources/apis/{api.rs,service.rs,gateway.rs,authhandler.rs}`, `builder/{codegen.rs,compile.rs,transpiler.rs,prepare.rs}`, and the binary entry `tsparser/src/bin/tsparser-encore.rs:1`.

Surrounding this:

- **`cli/`** — the Go-language `encore` CLI and the long-running `encore daemon` (Go). The daemon shells out to the `tsparser-encore` Rust binary via stdin/stdout (see `tsparser/src/bin/tsparser-encore.rs:18-80`). User-facing commands live in `cli/cmd/encore/*.go`.
- **`cli/daemon/`** — the daemon implementation. Subdirs `run/`, `pubsub/`, `redis/`, `sqldb/`, `objects/`, `dash/`, `mcp/`, `secret/`, `namespace/`, `apps/`, `engine/`. The daemon owns local-dev infra spinup (NSQ for pubsub, miniredis for cache, Postgres-via-docker for SQL) and serves the developer dashboard.
- **`runtimes/go/`** — the Go SDK, the original Encore. Symmetric to `runtimes/js/encore.dev` in shape. Out of scope for this review.
- **`v2/`** — the Go static-analysis parser, sibling to `tsparser/` for the Go SDK. Out of scope.
- **`supervisor/`** — small Rust process supervisor (`supervisor/src/supervisor.rs:32-110`), bundled into the Docker image for split-process deployments where each service runs as its own Node/Bun process under one image.

So the TS runtime is **TS surface + Rust runtime + Rust parser + Go CLI + Go daemon**, communicating across language boundaries via N-API, protobuf, and JSON-over-stdio. The TS user only sees `import { api } from "encore.dev/api"`. Everything else is implied.

License is **MPL-2.0** for both the framework (`LICENSE:1`) and the SDK (`runtimes/js/encore.dev/LICENSE:1`). The hosted **Encore Cloud** PaaS is closed-source; the OSS `encore deploy` command (`cli/cmd/encore/deploy.go:32-92`) is just a thin client to that PaaS API.

---

## 2. The TS primitives — verbatim

Every primitive follows the same shape: a class or factory function whose **constructor argument is a string-literal name**, and whose **runtime behavior is a thin wrapper around a Rust addon**. The class doesn't *create* any infra by itself — it asks the runtime for a handle to infra that the build pipeline has already arranged.

### Service

`runtimes/js/encore.dev/service/mod.ts:12-24`:

```ts
export class Service {
  public readonly name: string;
  public readonly cfg: ServiceConfig;
  constructor(name: string, cfg?: ServiceConfig) {
    this.name = name;
    this.cfg = cfg ?? {};
  }
}

export interface ServiceConfig {
  middlewares?: Middleware[];
}
```

Note line 11 of the doc-comment: *"It must be called from files named `encore.service.ts`, to enable Encore to efficiently identify possible service definitions."* This is enforced by the parser at `tsparser/src/parser/resources/apis/service.rs:53-59` — declaring a `Service` outside `encore.service.ts` is a hard error, and a directory containing that file becomes a service whose root is the directory and whose membership is that subtree (`tsparser/src/parser/parser.rs:259-287`).

### API endpoint

`runtimes/js/encore.dev/api/mod.ts:156-179`:

```ts
export function api<
  Params extends object | void = void,
  Response extends object | void = void
>(
  options: APIOptions,
  fn: (params: Params) => Promise<Response>
): HandlerFn<Params, Response>;

export function api(options: APIOptions, fn: any): typeof fn {
  return fn;
}

export type RawHandler = (req: IncomingMessage, resp: ServerResponse) => void;

api.raw = function raw(options: APIOptions, fn: RawHandler) {
  return fn;
};
```

**The `api()` function literally just returns the function passed in.** No wrapping, no registration, no decorator. The endpoint exists because the parser sees the call expression `api({...}, fn)` in a file under a service directory and registers it (`tsparser/src/parser/resources/apis/api.rs:181-205`). Streaming variants attach as `api.streamInOut`, `api.streamIn`, `api.streamOut` (line 258-260) and static-asset serving as `api.static` (line 331-333). `APIOptions` (line 59-111) covers `method`, `path`, `expose`, `auth`, `bodyLimit`, `tags`, `sensitive`.

### Pub/Sub topic

`runtimes/js/encore.dev/pubsub/topic.ts:10-33`:

```ts
export class Topic<Msg extends object>
  extends TopicPerms
  implements Publisher<Msg>
{
  public readonly name: string;
  public readonly cfg: TopicConfig<Msg>;
  private impl: runtime.PubSubTopic;

  constructor(name: string, cfg: TopicConfig<Msg>) {
    super();
    this.name = name;
    this.cfg = cfg;
    this.impl = runtime.RT.pubsubTopic(name);
  }

  public async publish(msg: Msg): Promise<string> {
    const source = getCurrentRequest();
    return this.impl.publish(msg, source);
  }
  ...
}
```

User-facing config (`pubsub/topic.ts:80-132`): `deliveryGuarantee: "at-least-once" | "exactly-once"` (the strings `atLeastOnce`/`exactlyOnce` are exported constants, line 46/75) plus an optional `orderingAttribute`. The message type is supplied as a generic type parameter `<Msg>`, and **the parser reads that type parameter** at `tsparser/src/parser/resources/infra/pubsub_topic.rs:120-122` to generate cross-language metadata.

### Pub/Sub subscription

`runtimes/js/encore.dev/pubsub/subscription.ts:6-35`:

```ts
export class Subscription<Msg extends object> {
  private readonly topic: Topic<Msg>;
  private readonly name: string;
  private readonly impl: runtime.PubSubSubscription;

  constructor(topic: Topic<Msg>, name: string, cfg: SubscriptionConfig<Msg>) {
    this.topic = topic;
    this.name = name;

    const handler = (msg: runtime.Request) => {
      setCurrentRequest(msg);
      return cfg.handler(msg.payload() as Msg);
    };

    this.impl = runtime.RT.pubsubSubscription({
      topicName: topic.name,
      subscriptionName: name,
      handler,
    });

    this.startSubscribing();
  }
  ...
}
```

Note line 26-34: the subscription starts itself by polling. There is *no* "register handler then await runtime start" two-phase. Just construct and it runs. Config (line 44-98) covers `handler`, `maxConcurrency`, `ackDeadline`, `messageRetention`, `retryPolicy: { minBackoff, maxBackoff, maxRetries }`. Critically the docstring at line 105-110 of subscription config says *"The values given to this structure are parsed at compile time, such that the correct Cloud resources can be provisioned to support the queue. As such the values given here may be clamped to the supported values by the target cloud."* That single sentence is the philosophy of Encore.ts.

### SQL database

`runtimes/js/encore.dev/storage/sqldb/database.ts:267-311`:

```ts
export class SQLDatabase extends BaseQueryExecutor {
  declare protected readonly impl: runtime.SQLDatabase;

  constructor(name: string, cfg?: SQLDatabaseConfig) {
    super(runtime.RT.sqlDatabase(name));
  }

  static named<name extends string>(name: StringLiteral<name>): SQLDatabase {
    return new SQLDatabase(name);
  }

  get connectionString(): string {
    return this.impl.connString();
  }

  async acquire(): Promise<Connection> {
    const impl = await this.impl.acquire();
    return new Connection(impl);
  }

  async begin(): Promise<Transaction> { ... }
}
```

`SQLDatabaseConfig` (line 9-11) is `migrations?: string | { path; source?: "prisma" | "drizzle" | "drizzle/v1" }`. Querying is via tagged template literals (`database.ts:63-76`), which gets you parameterised queries for free with `${}` substitution rewritten to `$1, $2, …` (line 364-376). There's a deliberate distinction: `new SQLDatabase("foo")` *creates* the DB, `SQLDatabase.named("foo")` *references* an existing one (line 274-280) — duplicate `new`s for the same name are a compile error.

### Object storage bucket

`runtimes/js/encore.dev/storage/objects/bucket.ts:24-34`:

```ts
export class Bucket extends BucketPerms implements Uploader, SignedUploader, Downloader, SignedDownloader, Attrser, Lister, Remover, PublicUrler {
  impl: runtime.Bucket;

  constructor(name: string, cfg?: BucketConfig) {
    super();
    this.impl = runtime.RT.bucket(name);
  }
```

Config: `{ public?: boolean; versioned?: boolean }` (line 7-19). The class implements a fan of "permission" interfaces (`Uploader`, `Downloader`, etc.) — these exist purely so you can declare the *capability* you want when passing a bucket reference around. A function that takes a `Downloader` cannot upload, and the parser enforces this at the call-site through the `bucket.ref<P>()` method (line 147-149) by reading the requested intersection-type permission set, then narrowing the IAM grants on the deployed cloud bucket.

### Cron job

`runtimes/js/encore.dev/cron/mod.ts:5-17`:

```ts
export class CronJob {
  public readonly name: string;
  public readonly cfg: CronJobConfig;
  constructor(name: string, cfg: CronJobConfig) {
    this.name = name;
    this.cfg = cfg;
  }
}

export type CronJobConfig = {
  endpoint: () => Promise<unknown>;
  title?: string;
} & ({ every: DurationString } | { schedule: string });
```

Note `endpoint: () => Promise<unknown>` — the user passes the **API function reference itself**, not a string name. The parser walks types to verify it's an Encore API endpoint and records the cron→endpoint relationship in metadata.

### Secret

`runtimes/js/encore.dev/config/secrets.ts:50-78`:

```ts
export function secret<Name extends string>(
  name: StringLiteral<Name>
): Secret<Name> {
  const impl = runtime.RT.secret(name);
  const secretObj = () => {
    if (impl === null) {
      if (
        runtime.RT.appMeta().environment.cloud === runtime.CloudProvider.Local
      ) {
        return "";
      }
      throw new Error(`secret ${name} is not set`);
    }
    return impl.cached();
  };

  secretObj.toString = () => {
    if (impl === null) return `Secret<${name}>(not set)`;
    return `Secret<${name}>(*********)`;
  };
  Object.defineProperty(secretObj, "name", { value: name });

  return secretObj as unknown as Secret<Name>;
}
```

The returned secret is callable — `mySecret()` returns the string. Two important behaviors: (a) silently returns `""` in local dev when unset, throws otherwise, and (b) `toString()` is overridden to mask the value, so accidental log-printing won't leak. Both are nice taste choices.

### Gateway, AuthHandler, Cache

For brevity: `Gateway` (`runtimes/js/encore.dev/api/gateway.ts`) declares a public-facing API gateway with auth handler attached; `AuthHandler` is a parser-recognized export from `service.middlewares`; `Cache` lives under `storage/cache/` with a `Cluster` + typed `KeyspaceDef` model that's deliberately Redis-only.

---

## 3. The infra-as-code mechanism — how Encore reconciles code with infra

This is the headline pattern, and it's two-phase: **parse-time metadata extraction** and **build-time/deploy-time provisioning binding**.

### Phase 1: Parse-time discovery (Rust)

When the daemon needs metadata about an app, it spawns the `tsparser-encore` Rust binary (`tsparser/src/bin/tsparser-encore.rs:18-80`). The binary uses **SWC** to parse every `.ts` file under the app root and walk the AST. For each Encore primitive, there's a `ResourceParser` that registers an "interesting package" and a callback that fires on each call/`new` expression referencing names from that package.

Example: `tsparser/src/parser/resources/infra/pubsub_topic.rs:61-97`:

```rust
pub const TOPIC_PARSER: ResourceParser = ResourceParser {
    name: "pubsub_topic",
    interesting_pkgs: &[PkgPath("encore.dev/pubsub")],

    run: |pass| {
        let names = TrackedNames::new(&[("encore.dev/pubsub", "Topic")]);
        let module = pass.module.clone();

        for r in iter_references::<PubSubTopicDefinition>(&module, &names) {
            let r = report_and_continue!(r);
            let object =
                resolve_object_for_bind_name(pass.type_checker, pass.module.clone(), &r.bind_name);

            let message_type = pass
                .type_checker
                .resolve_type(pass.module.clone(), &r.message_type);

            let delivery_guarantee = report_and_continue!(r.config.delivery_guarantee());
            let resource = Resource::PubSubTopic(Lrc::new(Topic {
                name: r.resource_name.to_owned(),
                doc: r.doc_comment,
                delivery_guarantee,
                message_type,
                ordering_attribute: r.config.orderingAttribute,
                span: r.range.to_span(),
            }));
            pass.add_resource(resource.clone());
            pass.add_bind(BindData {
                range: r.range,
                resource: ResourceOrPath::Resource(resource),
                object,
                kind: BindKind::Create,
                ident: r.bind_name,
            });
        }
    },
};
```

For each `new Topic(...)` call: extract the literal name (1st arg), parse the literal config object (2nd arg, decoded by the `LitParser` derive macro at line 40-45), pull the `<Msg>` generic to a fully resolved type, and record a **`BindData`** that says "this variable in this module *is* a topic resource of this shape." A separate "usage parser" walks call-sites of the bound variable (`pubsub_topic.rs:142-269`) to record `publish` calls and, crucially, calls to `topic.ref<Publisher>()` whose intersection-type argument tells Encore what permissions the call-site is requesting.

The same pattern repeats for every primitive. The output is a single **protobuf metadata blob** (`v1::Data`) built by `tsparser/src/legacymeta/mod.rs:32-100`, which contains every service, endpoint, topic, subscription, database, bucket, cron job, secret, and the type-checked schemas for every request/response payload and message type.

### Phase 2: Codegen (Rust → handlebars-rendered TS)

The same `tsparser-encore` binary then renders **per-service entrypoint files** into `<app>/encore.gen/` using Handlebars templates. The flow is in `tsparser/src/builder/codegen.rs:46-575`. The key template is `tsparser/src/builder/templates/entrypoints/services/main.handlebars`:

```handlebars
import { registerHandlers, run, type Handler } from "encore.dev/internal/codegen/appinit";
import { Worker, isMainThread } from "node:worker_threads";
{{#each endpoints}}
import { {{name}} as {{name}}Impl{{@index}} } from {{toJSON import_path}};
{{/each}}
{{#each subscriptions}}
import {{toJSON import_path}};
{{/each}}
...
const handlers: Handler[] = [
{{#each endpoints}}
    {
        apiRoute: {
            service:           {{toJSON ../name}},
            name:              {{toJSON name}},
            handler:           {{name}}Impl{{@index}},
            raw:               {{toJSON raw}},
            streamingRequest:  {{toJSON streaming_request}},
            streamingResponse: {{toJSON streaming_response}},
        },
        endpointOptions: {{toJSON endpoint_options}},
        middlewares: {{#if ../service.import_path}}{{encoreNameToIdent ../service.name}}_service.default.cfg.middlewares || {{/if}}[],
    },
{{/each}}
];

registerHandlers(handlers);

await run(import.meta.url);
```

This is the **only "main" the runtime ever executes**. The user's source files are consumed as imports; the user never writes a server bootstrap. The same codegen pass also produces typed client stubs (`templates/catalog/clients/endpoints_d_ts.handlebars`), an auth catalog, and a "combined main" that runs all services in one process.

### Phase 3: Build-time provisioning (Go daemon)

When the user runs `encore build docker IMAGE_TAG --config infra.config.json` (`cli/cmd/encore/build.go:32-76`), the daemon:

1. Re-runs the parser to get fresh metadata.
2. Reads the user-supplied `infra.config.json` (schema in `runtimes/core/src/infracfg.rs:13-30`), which **maps the parsed resource names to concrete cloud config**: `sql_servers[].databases[name] = {host, ...}`, `pubsub[].type = "gcp_pubsub" | "aws_sns_sqs" + topics[name] + subscriptions[name]`, `redis[name] = {host, ...}`, `object_storage[].type = "gcs" | "s3" + buckets[name]`, `secrets`, `metrics`, `service_discovery`, `cors`, etc.
3. Validates: every parsed resource must map to an entry in the config (`cli/daemon/export/infra_config.go:460+` writes "Your infra configuration is incomplete" for missing pieces).
4. Emits the **runtime config protobuf** (`infracfg.rs:795-900`) — the unified internal IR — and embeds it into the docker image at `/encore/infra.config.json` (`cli/daemon/export/infra_config.go:27`), passes its path via `ENCORE_INFRA_CONFIG_PATH` (line 209).
5. Bundles the user's transpiled TS (`tsparser/src/builder/transpiler.rs`), the generated `encore.gen/` entrypoints, the `encore.dev` package, the Rust N-API runtime, and the `supervisor` Rust binary into the docker image.

### Worked example: declaring a queue

User writes `services/orders/encore.service.ts`:

```ts
import { Service } from "encore.dev/service";
export default new Service("orders");
```

User writes `services/orders/events.ts`:

```ts
import { Topic } from "encore.dev/pubsub";

export interface OrderPlaced { orderId: string; userId: string; }

export const orderPlaced = new Topic<OrderPlaced>("order-placed", {
  deliveryGuarantee: "at-least-once",
});
```

What happens:

1. **Parse:** `pubsub_topic.rs:61` matches the `new Topic(...)` call. Resource registered: `name="order-placed"`, `delivery_guarantee=AtLeastOnce`, `message_type=OrderPlaced` (resolved to a `Type::Named` with full field schema).
2. **Service inference:** Because `events.ts` is under the `orders/` directory which contains `encore.service.ts`, the topic is associated with the `orders` service.
3. **Codegen:** No special generated import for the topic itself (publishers don't need it), but if you also wrote `new Subscription(orderPlaced, "ship-order", { handler: shipOrder })` in `services/shipping/`, then `encore.gen/internal/entrypoints/services/shipping/main.ts` gets `import "../../../../../shipping/index.ts"` to ensure the subscription module is loaded and starts polling.
4. **Build:** User supplies `infra.config.json`:
   ```json
   {
     "pubsub": [{
       "type": "aws_sns_sqs",
       "topics": { "order-placed": { "name": "prod-order-placed" } },
       "subscriptions": { "ship-order": { "name": "prod-ship-order" } }
     }]
   }
   ```
   The daemon builds the runtime-config protobuf with `pub_sub_cluster::Provider::Aws(...)`, embeds it in the image.
5. **Runtime:** On boot, `runtimes/core/src/pubsub/manager.rs:689-710` matches on `Provider::Aws(_)` and constructs `sqs_sns::Cluster::new()`. From then on, `orderPlaced.publish(msg)` from TS calls into `runtime.RT.pubsubTopic("order-placed").publish(...)` which routes to the SNS publisher in Rust.

**Encore does not provision the SNS topic for you.** That's done by your Terraform/CDK/Pulumi or Encore Cloud's PaaS. What Encore does is *bind* the code-declared name to a concretely-configured cloud resource, with end-to-end type checking from the TS schema to the cross-language IR.

---

## 4. Multi-cloud deploy story

### What gets swapped

The "same code targets AWS / GCP / self-host" story works because **every primitive has a Rust adapter behind a trait**, and the runtime-config protobuf picks which adapter to instantiate at boot. There is **no per-cloud TS shim and no per-cloud build artifact** — there is one docker image per app, and a JSON config per environment.

| Primitive   | Trait / dispatch site                                  | Adapters                                                                                    |
| ----------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| Pub/Sub     | `runtimes/core/src/pubsub/manager.rs:689-710`          | `gcp/`, `sqs_sns/`, `nsq/` (local), `noop/`                                                 |
| Object Storage | `runtimes/core/src/objects/manager.rs`              | `gcs/`, `s3/`, `noop/`                                                                      |
| SQL         | `runtimes/core/src/sqldb/manager.rs`                   | Single Postgres client (any Postgres-wire backend works)                                    |
| Cache       | `runtimes/core/src/cache/manager.rs`                   | Redis client + `miniredis.rs` (in-process), `noop.rs`                                       |
| Secrets     | `runtimes/core/src/secrets/`                           | Env vars, GCP Secret Manager, AWS Secrets Manager (per `infracfg.rs` Secrets config)        |
| Metrics     | `runtimes/core/src/metrics/`                           | Prometheus, GCP Cloud Monitoring (`infracfg.rs:120,525-532`), Datadog                       |

### Build artifact

A single **portable Docker image**, built by `cli/daemon/export/export.go:36-300`. Two layouts (`buildSettings.Docker.ProcessPerService` flag at line 145):

- **All-in-one process:** `node` runs the combined entrypoint at `encore.gen/internal/entrypoints/combined/main.ts`. Smaller, simpler, single failure domain.
- **Process-per-service:** the `supervisor-encore` Rust binary (`supervisor/src/supervisor.rs:32-110`) is the image entrypoint and forks one Node/Bun process per service from `encore.gen/internal/entrypoints/services/<svc>/main.ts`, plus one per gateway. Independent restart, isolated memory.

The image is **base-image agnostic** (`cli/cmd/encore/build.go:66`: `--base scratch` for Go, `--base node:slim` for TS by default at line 53-55), and the `--push` flag publishes to a registry. Source bundling is forced for TS (line 148: `if … appLang == appfile.LangTS`).

### `encore deploy`

`cli/cmd/encore/deploy.go:32-92` is **alpha-only**, requires a logged-in Encore Cloud account, and just calls `platform.Deploy()` against the proprietary PaaS API. There is **no OSS Pulumi/Terraform/CDK/CRD generation** in the repo. If you self-host, you write your own pipeline that:

1. Calls `encore build docker IMAGE_TAG --config <env>.infra.config.json`.
2. Provisions the cloud resources (your way — Terraform, manual, whatever).
3. Deploys the image (Kubernetes, ECS, Cloud Run, plain VM — your call).
4. Sets `ENCORE_INFRA_CONFIG_PATH` if not the default; injects secrets; opens the right ports.

Encore takes itself out of the deploy decision. That's a deliberate piece of taste worth lifting.

---

## 5. Local dev — what `encore run` does

`cli/cmd/encore/run.go` defines the `Use: "run [--debug] [--watch=true] [--level=TRACE] [--port=4000] [--listen=<listen-addr>]"` command. It connects to the always-on daemon (`cli/cmd/encore/daemon.go`), which orchestrates a long-running app group via `cli/daemon/run/run.go` (878 LOC) + `proc_groups.go` (532 LOC) + `runtime_config2.go` (1004 LOC).

The daemon's `infra.ResourceManager.StartRequiredServices` (`cli/daemon/run/infra/infra.go:96-112`) inspects the parsed metadata and conditionally spins up:

- **PostgreSQL** via `sqldb.ClusterManager` — runs Postgres in a managed Docker container, applies migrations, serves a proxy on `localhost:<dbProxyPort>` (line 282-284, 380-382).
- **NSQ** as the local Pub/Sub backend — `pubsub.NSQDaemon` (line 116-126); a Go-embedded nsqd. The runtime adapter selected at boot is `nsq::Cluster::new(...)` (`runtimes/core/src/pubsub/manager.rs:697-699`).
- **miniredis** as the local Cache backend — pure-Go in-process Redis (line 140-160). The Rust runtime uses `cache/miniredis.rs`.
- **Local object storage** via `objects.ClusterManager` (line 109-111) — a daemon-hosted HTTP server that mimics S3/GCS, with a `PublicBucketServer` for public-bucket URLs.

So the user runs `encore run` and gets, for free: a fresh Postgres with migrations applied, an NSQ daemon, a miniredis, a local S3-alike, **a developer dashboard at `localhost:9400`** (`cli/daemon/dash/`) showing live request traces with end-to-end timeline waterfalls, a **type-safe API client catalog** regenerated on every change, **schema validation** against the parsed types, and **MCP server** integration for IDE/AI tooling (`cli/daemon/mcp/`).

`watch=true` (the default) reparses on file change and hot-reloads the affected processes. The codegen tree (`encore.gen/`) is rewritten in place so TypeScript autocomplete updates immediately.

This is a **massive amount of free DX** that comes from the daemon owning the dev loop. Compare to Flue (`flue dev` is just a watch-mode esbuild + restart), or to a typical Next.js project (you bring your own Postgres). Encore's dev loop is closer to Rails-with-`bin/dev` than to a microservices framework.

---

## 6. CLI surface — every verb, vs Flue's three

Top-level verbs (from `cli/cmd/encore/*.go` — `grep -h "Use:"`):

| Verb | File | Purpose |
| --- | --- | --- |
| `encore app init/create/clone/link` | `cmd/encore/app/*.go` | Scaffold or attach a project to Encore Cloud |
| `encore auth login/logout/whoami/signup` | `cmd/encore/auth/` | Encore Cloud session management |
| `encore build docker IMAGE_TAG` | `build.go:42` | Produce portable docker image |
| `encore check` | `check.go` | Parse + typecheck without running |
| `encore daemon` (env, ...) | `daemon.go` | Manage the always-on background daemon |
| `encore db reset/shell/proxy/conn-uri` | `db.go` | Local + remote DB ops |
| `encore alpha deploy --commit/--branch` | `deploy.go:32` | Alpha: deploy via Encore Cloud PaaS only |
| `encore exec script.ts` | `exec.go` | Run a one-shot script with the runtime initialised |
| `encore gen client / wrappers` | `gen.go` | Generate type-safe clients (TS/Go/OpenAPI) for an app |
| `encore logs --env=prod` | `logs.go` | Tail logs from Encore Cloud |
| `encore run` | `run.go` | Local dev — see §5 |
| `encore mcp start/run` | `mcp.go` | Model Context Protocol server |
| `encore secrets ...` | `secrets/` | Manage cloud-stored secrets |
| `encore namespace ...` | `namespace/` | Local-dev namespaces (separate Postgres/Redis/NSQ instances per branch) |
| `encore k8s ...` | `k8s/` | Kubernetes-specific helpers |
| `encore test [go test flags]` | `test.go` | Run tests with the runtime mocked |
| `encore version / update` | `version.go` | Self-update |
| `encore alpha ...` | various | Experimental commands |
| `encore debug meta` | `debug.go` | Dump parsed metadata as JSON |
| `encore rand uuid/bytes/words` | `rand.go` | Convenience generators |
| `encore telemetry enable/disable` | `telemetry.go` | Opt-out toggle |

That's roughly **20 top-level verbs** (more if you count subcommands). Compare to Flue's `dev | run | build` discipline (`flue/packages/cli/bin/flue.ts:228-305`).

**The honest comparison:**

- Encore *does* have `init`, `dev`-equivalent (`run`), `build`, and a non-existent OSS `deploy` — those four match the Flue shape semantically.
- But Encore *also* hosts `auth`, `app link`, `logs`, `secrets`, `namespace`, `db`, `gen`, `mcp`, `telemetry`, `daemon`, `k8s`, `exec`, `check`, `test`, `debug`, `version`, `update`, `rand`. Many of these exist because Encore is also a *PaaS client* (`auth`, `logs`, `secrets`, `app link`), and many because Encore's dev-loop daemon is a big stateful thing that needs management (`daemon env`, `namespace`).

For Thodare, the lesson is: **Flue's three-verb discipline only stays clean if you refuse to be a PaaS client**. The moment Thodare ships a hosted `thodare-cloud`, you'll have `thodare auth`, `thodare logs`, `thodare secrets`, etc. The lever to keep things clean is to push every cloud-platform-specific operation into the platform's *native* CLI (just as Flue defers to `wrangler deploy`). If Thodare ships per-platform Worlds (`world-cloudflare`, `world-vercel`, `world-aws`), the deploy verbs should belong to those clouds' own CLIs, not to `thodare`.

Encore's `encore namespace` deserves a closer look — it lets developers spin up isolated local-dev environments per git branch (each with its own Postgres / Redis / NSQ data). That's a feature Thodare's local dev story might want.

---

## 7. Top 10 surprises

1. **The `api()` function is the identity function.** `runtimes/js/encore.dev/api/mod.ts:171-173` literally returns the function passed in. All the magic is parser-driven, not runtime decorator-driven.
2. **No annotations, no decorators, no manifest.** Resources are discovered by **`new ClassName("literal-string-name", literal-config-object)`** call-pattern matching. The literal name and the literal config object must be statically analysable — you can't `new Topic(envVar, ...)` without a parser error. The literal-parser is a derive macro: `#[derive(LitParser)]` (e.g. `pubsub_topic.rs:40`).
3. **The TS SDK is a thin facade over a Rust N-API addon.** `runtime.RT.pubsubTopic(name).publish(msg)` is JS-to-Rust on every call. The runtime-trace, the metrics, the connection pooling, the protobuf encoding — all in Rust.
4. **Type inspection is cross-language.** The Rust SWC parser resolves TypeScript generic type parameters and serializes them into a protobuf type schema (`tsparser/src/legacymeta/schema.rs`). Then the runtime, also Rust, validates payloads against that schema. The TS compiler is bypassed entirely for runtime validation; SWC + custom type-resolution does it.
5. **`encore.service.ts` as the only valid place to declare a service** (`tsparser/src/parser/resources/apis/service.rs:53-59`). Everything else in the directory tree under that file is "in" the service. This is convention so heavy it's syntax. It works, but it's surprising the first time you see it.
6. **There is no first-party `deploy` for self-hosters.** `cli/cmd/encore/deploy.go:32-92` only deploys to Encore Cloud. The OSS path is `encore build docker → push to registry → your-own-cd-pipeline`. The framework deliberately stops at producing a portable image. (Same taste as Flue.)
7. **No durable-execution / workflow primitive.** Encore.ts has services, APIs, queues, crons, DBs, buckets, secrets — but **no `workflow` primitive**, no Temporal/Restate-style replayable functions. Pub/Sub + idempotent handlers + cron + retry policy is the durable-execution story. This is a gap Thodare can deliberately fill.
8. **`Subscription` self-starts in its constructor** (`pubsub/subscription.ts:26-34`). Constructing the object kicks off background polling with auto-reconnect (`startSubscribing` re-arms a setTimeout on every finally-block). Side effects in constructors — common in Encore primitives — are great DX and a testability nightmare.
9. **Permissions via TypeScript intersection types.** `topic.ref<Publisher>()` (`pubsub/topic.ts:30-32`) returns the topic typed as having only the publish permission. The parser reads the type intersection at the call-site (`pubsub_topic.rs:184-269`) to compute IAM grants. Permissions are *expressed in the type system* and *enforced by the parser*. Genuinely clever.
10. **The dev daemon is always-on.** `encore run` doesn't start a server — it asks the daemon (via JSONRPC over a Unix socket; `cli/internal/jsonrpc2/`) to start one. The daemon owns Postgres/NSQ/miniredis/local-S3 instances across all your apps and across all your branches. This is great for resource sharing but it's a piece of state a typical Node dev isn't expecting.

---

## 8. Implications for Thodare

### Lift wholesale

**The literal-name-and-literal-config call pattern.** Thodare's primitives — `new Workflow("user-onboarding", {...})`, `new Step("send-email", {...})`, `new Schedule("daily-cleanup", {...})` — should follow the exact same shape: a class taking a string-literal name and a literal config object. This makes static analysis trivial, matches user mental model ("the variable name is a TypeScript thing, the resource name is a deployment thing, they don't have to match but both are explicit"), and lets you do everything Encore does (cross-cloud naming, automatic config validation, type-safe references).

**The two-layer naming distinction: `new X(...)` creates, `X.named(...)` references** (e.g. `SQLDatabase.named()` in `database.ts:278-280`). Cleanly separates "this code owns this resource" from "this code consumes a resource owned elsewhere." Thodare workflows that fan out to other workflows want this.

**Permissions via TS intersection types.** This pattern (`topic.ref<Publisher>()` → parser narrows IAM on deploy) maps perfectly onto Thodare's question of "can step X enqueue into queue Y." Each World can implement its own permission narrowing (Cloudflare bindings, Lambda IAM, Vercel project-level grants).

**Per-primitive Rust trait + per-cloud adapter behind a `match provider {...}` boot dispatch.** `runtimes/core/src/pubsub/manager.rs:689-710` is the textbook example of how to do multi-cloud right. Thodare's `World` interface should be the TS analogue of this — every primitive declares an abstract operation set, and each per-platform World package supplies the concrete adapter. The dispatch happens once at app boot from a single config blob.

**The infra-config-blob-at-build-time pattern.** Encore's `infra.config.json` is the seam. The application code declares *what* it needs; the build accepts *where* those things live; the runtime binds the two. For Thodare, the analogue is `thodare.world.json` (or env vars, or a TS file): "this `Workflow("foo")` runs on Cloudflare Workflows in account X, this `Queue("bar")` is SQS queue Y in region Z." Thodare's `BuildPlugin` (per Flue) should be the producer of this config alongside the bundle.

**The supervisor pattern for split-process deployments** (`supervisor/src/supervisor.rs`). If Thodare ever offers a self-host docker image with multiple workflows running in isolated processes, a tiny Rust supervisor with restart policy is the right shape. (Or steal `encore.dev/internal/codegen/appinit` as a TS-only equivalent, since you don't need cross-language.)

**Topic config with cloud-clamping documentation** (`pubsub/subscription.ts:105-110`): *"the values given here may be clamped to the supported values by the target cloud."* Document this explicitly in every Thodare primitive that has cloud-vendor-specific limits (queue retention, max retries, ack deadlines, etc.). It sets expectations correctly.

**The dev daemon owning local infra.** Encore's NSQ + miniredis + Postgres-in-Docker spinup is a serious DX multiplier. Thodare should consider a similar pattern — `thodare dev` brings up whatever local dependencies the declared primitives need (e.g. local Postgres for state, local NATS for pubsub, local SQLite for testing). This is the Flue-incompatible path though: Flue is deliberately stateless on the dev side. Pick one.

**The `encore.gen/` codegen tree as an in-tree artifact.** Generated entrypoints + typed clients written into the user's repo (gitignored) is more honest than burying them in `node_modules/`. The user can read the generated code and understand what's actually running. Thodare should do the same — generate `.thodare/` (gitignored) with the entrypoint and any per-World adapter code.

### Lift selectively

**Static analysis for resource discovery.** The Rust SWC parser is a heavy machine — it's there because Encore is multi-language and needs cross-language type resolution. Thodare is TS-only, so you can lean on the **TypeScript Compiler API + ts-morph** instead, do the same AST walk in TS, and avoid the multi-language weight. The pattern (literal call recognition, type-arg extraction, AST walk for usages) is what matters; the language of the analyzer doesn't.

**The decision to put the TS parser in Rust** is paying down debt for Encore's cross-language past, not gaining present value. Don't copy this. ts-morph + a small set of `Node.isCallExpression` visitors will do everything Encore's `tsparser` does for a TS-only world, in 1/10th the LOC, with no FFI.

**Encore Cloud's PaaS coupling.** `encore deploy`, `encore logs`, `encore secrets`, `encore auth`, `encore namespace` (kind of) — these are Encore Cloud client commands grafted onto the same CLI as the OSS framework. It blurs the OSS/PaaS boundary in a way that breeds suspicion. Thodare should keep `thodare-cloud` as a separate npm package and a separate CLI (`thc` perhaps). The OSS `thodare` CLI stays at three verbs.

**Always-on daemon.** Encore's daemon (`cli/cmd/encore/daemon.go`) is a long-running background process per machine. Useful for sharing Postgres across your branches; surprising on a fresh laptop. Flue has none. For Thodare, a daemon is a "later" decision. Ship `dev/run/build` as standalone first; daemonize only if shared local state becomes painful.

### Deliberately diverge

**Thodare must have a workflow / durable-execution primitive.** Encore doesn't. Encore's "workflow" answer is "Pub/Sub + idempotent subscriber + cron." That's not enough for Thodare's brief — Thodare's whole reason to exist is durable workflows with replay, cancellation, child workflows, signals. The Encore-shaped analogue would be:

```ts
import { workflow, step } from "thodare";

export const onboardUser = workflow("onboard-user", async (ctx, userId: string) => {
  const user = await step("fetch-user", () => fetchUser(userId));
  await step("send-welcome", () => sendEmail(user.email, "welcome"));
  await ctx.sleep("1 day");
  await step("send-followup", () => sendEmail(user.email, "followup"));
});
```

…where `workflow()` and `step()` are recognised by the parser, the workflow body is statically analysed for the step graph, and the World swaps in Cloudflare Workflows / Temporal / Inngest / a Postgres-backed local engine depending on target.

**Eject-friendly generated code.** Encore's `encore.gen/` is regenerated on every parse; users aren't expected to read it. Thodare's generated entrypoints should be **production-grade, hand-readable, eject-able TS** that a user could fork and own. This makes Thodare an "AI-buildable, human-ownable" framework rather than a "magic that runs on Encore Cloud" framework.

**Convention-over-config has limits.** Encore's `encore.service.ts` rule (you must declare your service in this exact filename) is *clever* but *un-Google-able for newcomers*. Thodare should pick conventions that are discoverable by reading the source: `workflows/foo.workflow.ts` exporting a default `Workflow`, no special filename rule.

**No `Subscription`-style self-starting constructors.** Encore's subscription auto-polls from its constructor (`subscription.ts:26-34`). This is great for "import the file and it just works" but terrible for testing. Thodare's primitives should be **declarative-only at construction**; the entrypoint codegen is what wires them up. Side-effect-free constructors are testable; side-effectful ones aren't.

**Build artifact is whatever the World says.** Encore standardises on a Docker image. Cloudflare doesn't take Docker — Wrangler takes a JS bundle + manifest. Vercel takes a `vercel.json` + functions tree. Lambda takes a zip or an OCI image. Thodare's `BuildPlugin` (per Flue) must let each World produce its own native artifact (`world-cloudflare` produces `dist/wrangler.jsonc + _entry.ts`, `world-aws` produces `dist/lambda.zip + cdk.json`, `world-self-host` produces `dist/Dockerfile + entrypoint.ts`). Don't force a Docker monoculture.

### Concrete additions to Thodare's `BuildPlugin` interface

Drawing from Encore's codegen pipeline (`tsparser/src/builder/codegen.rs:46-575`):

```ts
interface BuildPlugin {
  name: string;
  generateEntryPoint(ctx: BuildContext): string | Promise<string>;     // (Flue today)
  bundle?: 'esbuild' | 'none';                                         // (Flue today)
  esbuildOptions?(ctx): Record<string, any>;                            // (Flue today)
  additionalOutputs?(ctx): Record<string,string>;                       // (Flue today)

  // New, Encore-inspired:
  generateInfraConfigSchema?(ctx): JSONSchema;                          // declares "what bindings does this World need"
  validateInfraConfig?(ctx, cfg): ValidationResult;                     // "your config is missing: queue X"
  generateClientCatalog?(ctx): Record<string,string>;                   // typed clients for cross-workflow calls
  generatePerPrimitiveAdapters?(ctx): Record<ResourceKind, AdapterCode>; // per-cloud Pub/Sub vs Queue vs Workflow
}
```

The two new shapes (`generateInfraConfigSchema` + `validateInfraConfig`) come straight from Encore's `infra.config.json` validation flow (`cli/daemon/export/infra_config.go:45-100, 460+`). The build can fail fast with a precise "your `Queue("foo")` has no binding in `world-cloudflare.json`" error rather than a runtime-only "queue-not-found."

### Encore patterns Thodare should NOT absorb

- The Rust+Go+TS polyglot. Thodare is TS-end-to-end. Resist the temptation.
- The `encore.service.ts` filename-as-syntax convention.
- The PaaS-client commands (`auth`, `logs`, `secrets`, `app link`) on the OSS CLI.
- The always-on background daemon (yet).
- Side-effects in primitive constructors.

---

## Executive summary

Encore.ts is a Rust-parser-driven, multi-cloud, infrastructure-as-code TypeScript framework that pioneered the pattern Thodare aims to adopt: **declare cloud primitives as ordinary TS objects (`new Topic("foo", {...})`), have a static analyzer recognize them at build time, and let each cloud target supply its own runtime adapter behind a single config blob**. The TS SDK at `runtimes/js/encore.dev/` is shockingly thin — `api()` is the identity function (`api/mod.ts:171-173`); `Topic`, `SQLDatabase`, `Bucket`, `Subscription` are tiny wrappers around an N-API Rust addon. Magic is in `tsparser/`, where SWC walks user TS and emits `encore.gen/` entrypoints via Handlebars (`builder/codegen.rs:46-575`) plus a metadata protobuf that the runtime cross-references against a build-time `infra.config.json` (`runtimes/core/src/infracfg.rs:13-30`). Multi-cloud is one trait per primitive with adapters under `runtimes/core/src/{pubsub,objects,cache,sqldb}/{gcp,sqs_sns,nsq,gcs,s3,...}/`, dispatched at boot (`pubsub/manager.rs:689-710`). Local dev is fat: the always-on Go daemon spins up Postgres, NSQ, miniredis, and local S3 (`cli/daemon/run/infra/infra.go:96-160`) plus a dashboard. The OSS `encore deploy` is a stub for Encore Cloud; OSS deploy = `encore build docker IMAGE_TAG` + your own pipeline. License is **MPL-2.0**, hosted PaaS is closed. Thodare should lift: the literal-name + literal-config + static-analysis pattern, the `X.named()` vs `new X()` distinction, permissions-via-TS-intersection-types, the per-primitive trait + per-cloud-adapter shape, and the build-time config-blob seam. Thodare should diverge: ship a real workflow primitive (Encore lacks one), do the parser in ts-morph not Rust, keep PaaS-client commands off the OSS CLI, avoid filename-as-syntax conventions, and make every BuildPlugin produce its World's native artifact rather than enforcing Docker.

**File:** `/Users/mithushancj/Documents/asyncdot/openscoped/agent-control-panel/thodare/research/code-reviews/encore-ts.md`
