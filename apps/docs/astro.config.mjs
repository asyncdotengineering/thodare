import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";

// Astro + Starlight + Diataxis-discipline: tutorial / how-to / reference / explanation.
export default defineConfig({
  site: "https://asyncdotengineering.github.io",
  base: "/thodare",
  integrations: [
    starlight({
      title: "Thodare",
      description: "Typed, durable workflows for AI-driven internal ops.",
      logo: { src: "./public/thodare-mascot.png", alt: "Thodare" },
      favicon: "/thodare-mascot.png",
      social: [
        {
          icon: "github",
          label: "GitHub",
          href: "https://github.com/asyncdotengineering/thodare",
        },
        {
          icon: "npm",
          label: "npm",
          href: "https://www.npmjs.com/org/thodare",
        },
      ],
      editLink: {
        baseUrl:
          "https://github.com/asyncdotengineering/thodare/edit/main/packages/docs/",
      },
      lastUpdated: true,
      pagination: true,
      sidebar: [
        {
          label: "Start here",
          items: [
            { label: "What is Thodare?", slug: "start/what-is-thodare" },
            { label: "Quickstart", slug: "start/quickstart" },
            { label: "Reference example", slug: "start/reference-example" },
          ],
        },
        {
          label: "Tutorials",
          items: [
            { label: "Build your first workflow", slug: "tutorials/first-workflow" },
            { label: "The LLM repair loop, end to end", slug: "tutorials/repair-loop" },
            { label: "Cron-driven workflow", slug: "tutorials/cron-driven" },
          ],
        },
        {
          label: "How-to guides",
          items: [
            { label: "Define a connector", slug: "how-to/define-connector" },
            { label: "Register a webhook route", slug: "how-to/register-webhook" },
            { label: "Schedule a workflow", slug: "how-to/schedule-workflow" },
            { label: "Issue + revoke API keys", slug: "how-to/manage-keys" },
            { label: "Bootstrap a fresh deployment", slug: "how-to/bootstrap-admin" },
            { label: "Deploy on Bun / Node / Workers", slug: "how-to/deploy" },
          ],
        },
        {
          label: "Reference",
          items: [
            { label: "Package map", slug: "reference/packages" },
            { label: "HTTP routes", slug: "reference/routes" },
            { label: "EditOp shape", slug: "reference/editop" },
            { label: "Error codes", slug: "reference/errors" },
            { label: "CLI commands", slug: "reference/cli" },
            { label: "Auth model", slug: "reference/auth-model" },
          ],
        },
        {
          label: "Explanation",
          items: [
            { label: "How a run executes", slug: "explanation/how-it-runs" },
            { label: "The LLM patch loop primitive", slug: "explanation/patch-loop" },
            { label: "Why one runtime workflow", slug: "explanation/runtime-workflow" },
            { label: "Pin-at-run-start", slug: "explanation/pin-at-run-start" },
            { label: "Why we vendor openworkflow", slug: "explanation/vendor-openworkflow" },
            { label: "Threat model", slug: "explanation/threat-model" },
            { label: "Naming — Thodare", slug: "explanation/naming" },
          ],
        },
        {
          label: "Project",
          items: [
            { label: "Roadmap", slug: "project/roadmap" },
            { label: "Contributing", slug: "project/contributing" },
            { label: "Changelog", slug: "project/changelog" },
            { label: "Acknowledgements", slug: "project/acknowledgements" },
          ],
        },
      ],
    }),
  ],
});
