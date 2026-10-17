// Compatibility hooks retained for existing message and settings callers.
// Rating prompts and rating-related persistence are disabled.
export async function tryOpenAppStoreReviewPage(): Promise<void> {}

export async function recordAppStoreRatingClick(): Promise<void> {}

export function tickAfterMessageGenerated(): void {}
