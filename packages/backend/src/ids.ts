declare const RunIdBrand: unique symbol;
export type RunId = string & { readonly [RunIdBrand]: typeof RunIdBrand };

declare const StepIdBrand: unique symbol;
export type StepId = string & { readonly [StepIdBrand]: typeof StepIdBrand };

declare const EventIdBrand: unique symbol;
export type EventId = string & { readonly [EventIdBrand]: typeof EventIdBrand };

declare const HookIdBrand: unique symbol;
export type HookId = string & { readonly [HookIdBrand]: typeof HookIdBrand };

declare const OrganizationIdBrand: unique symbol;
export type OrganizationId = string & {
  readonly [OrganizationIdBrand]: typeof OrganizationIdBrand;
};
