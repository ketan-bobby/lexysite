export function erasureAccountStatus(state?: string | null): string | null {
  switch (state) {
    case "closed":
      return "Candidate-only login closed; previous sessions and recovery links are revoked.";
    case "staff_identity_preserved":
      return "Shared staff/admin login preserved; erased candidate profile unlinked.";
    case "other_profiles_remaining":
      return "Account closure was deferred for review: another live profile shared this login at erasure.";
    case "multi_region_review_required":
      return "Account closure needs cross-region review before disabling the login.";
    case "no_linked_identity":
      return "No linked login identity to close.";
    default:
      return null;
  }
}
