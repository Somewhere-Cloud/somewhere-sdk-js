import { useEntitlements, type BillingObservation } from '../src/auth/react.js';
const observation: BillingObservation = { status: 'ready', features: ['exports'] };
const result = useEntitlements(observation);
if (result.status === 'ready') {
  const allowed: boolean = result.has('exports');
  const features: readonly string[] = result.entitlements;
  void allowed; void features;
} else {
  // @ts-expect-error Unobserved billing cannot be treated as a ready denial.
  result.has('exports');
  // @ts-expect-error Unobserved billing has no empty/free feature list.
  result.entitlements;
}
