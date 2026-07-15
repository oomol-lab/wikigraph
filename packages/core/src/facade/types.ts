export interface SpineDigestSerialEntry {
  readonly fragmentCount: number;
  readonly serialId: number;
  readonly title: string | null;
  readonly tocPath: readonly string[];
}
