/// ---------------------------------------------------------------------------
/// Verified user badges — a tiny registry for accounts Myto itself verifies.
///
/// The founder account (explorearafat@gmail.com) carries the blue tick next to
/// its username everywhere, and a fixed 238.7K follower display. Verified
/// status travels in the public profile doc (`profiles/{uid}.verified`), which
/// the app stamps on save for verified emails — so OTHER clients see the tick
/// on that user without knowing their email.
/// ---------------------------------------------------------------------------
const Set<String> kVerifiedEmails = <String>{'explorearafat@gmail.com'};

bool isVerifiedEmail(String? email) =>
    email != null && kVerifiedEmails.contains(email.trim().toLowerCase());

/// The follower display for a verified account (the real count is tiny while
/// the community is young — the brand account shows its established number).
const String kVerifiedFollowersLabel = '238.7K';
