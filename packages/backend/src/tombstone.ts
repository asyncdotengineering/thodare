// Additive-only fields exposed to adapters. The base SerializedBlock lives in
// @thodare/engine; Phase 1 cannot depend on engine, so we export only the
// fields adapters need to recognize a tombstoned block at the wire format.

export interface BlockTombstoneFields {
  tombstone?: true;
  tombstoneOriginalType?: string;
}
