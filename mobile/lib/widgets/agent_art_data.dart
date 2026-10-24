/// ---------------------------------------------------------------------------
/// GENERATED FILE — do not edit by hand.
///
/// The 18 hand-drawn agent avatars from the Myto avatar library, stored as
/// inline SVG so they render exactly as designed (crisp at any size, no
/// raster assets, no per-avatar painter code). Regenerate with
/// `python scripts/gen_agent_art.py` after editing the library HTML.
/// ---------------------------------------------------------------------------
library;

/// One avatar: a stable id, the display name, and the SVG markup.
class AgentArt {
  const AgentArt(this.id, this.name, this.svg);

  final String id;
  final String name;
  final String svg;
}

/// Every avatar in the library, in library order.
const List<AgentArt> kAgentArtLibrary = <AgentArt>[
  AgentArt(
    'qa-tester',
    'QA Tester',
    r'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><defs><linearGradient id="qaBg" x2="0" y2="1"><stop stop-color="#fff1c9"/><stop offset="1" stop-color="#f4bd56"/></linearGradient><linearGradient id="qaMetal" x2="1" y2="1"><stop stop-color="#26374d"/><stop offset="1" stop-color="#101a2b"/></linearGradient></defs><circle cx="50" cy="50" r="46" fill="url(#qaBg)"/><circle cx="50" cy="50" r="40" fill="#fff" opacity=".18"/><path d="M50 15 76 25 73 57Q68 75 50 85 32 75 27 57L24 25Z" fill="#d08b24"/><path d="M50 20 70 28 68 56Q64 70 50 78 36 70 32 56L30 28Z" fill="url(#qaMetal)" stroke="#ffe29b" stroke-width="3"/><path d="m40 49 7 7 15-17" fill="none" stroke="#ffd35f" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/><path d="m40 49 7 7 15-17" fill="none" stroke="#fff2bd" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>''',
  ),
  AgentArt(
    'doctor',
    'Doctor',
    r'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><defs><linearGradient id="docBg" x2="1" y2="1"><stop stop-color="#ffe8ed"/><stop offset="1" stop-color="#f4aebd"/></linearGradient><linearGradient id="docCard" x2="1" y2="1"><stop stop-color="#fff"/><stop offset="1" stop-color="#f1f4f8"/></linearGradient></defs><circle cx="50" cy="50" r="46" fill="url(#docBg)"/><rect x="22" y="20" width="56" height="60" rx="15" fill="#e39aaa"/><rect x="25" y="17" width="50" height="60" rx="13" fill="url(#docCard)" stroke="#fff" stroke-width="3"/><path d="M45 31h10v10h10v10H55v10H45V51H35V41h10Z" fill="#f14c63"/><path d="M67 28c12 0 13 17 1 18" fill="none" stroke="#334052" stroke-width="4" stroke-linecap="round"/><circle cx="66" cy="29" r="6" fill="#fff" stroke="#334052" stroke-width="4"/></svg>''',
  ),
  AgentArt(
    'bug-analyzer',
    'Bug Analyzer',
    r'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><defs><linearGradient id="bugBg" x2="1" y2="1"><stop stop-color="#dff2ff"/><stop offset="1" stop-color="#7bc4f5"/></linearGradient><linearGradient id="bugCore" x2="1" y2="1"><stop stop-color="#253b7d"/><stop offset="1" stop-color="#111a3e"/></linearGradient></defs><circle cx="50" cy="50" r="46" fill="url(#bugBg)"/><rect x="25" y="20" width="42" height="56" rx="18" fill="url(#bugCore)"/><path d="M35 29 42 23 49 29 48 39 36 39Z" fill="#4f76c9"/><path d="M25 35 17 29M24 48H14M27 62l-8 7M63 35l8-6M66 48h9M63 62l8 7" stroke="#152448" stroke-width="5" stroke-linecap="round"/><circle cx="59" cy="57" r="17" fill="#1db8ee" stroke="#d7f6ff" stroke-width="5"/><circle cx="59" cy="57" r="9" fill="#173e68"/><path d="m70 69 13 13" stroke="#173e68" stroke-width="8" stroke-linecap="round"/><circle cx="59" cy="57" r="4" fill="#6fe5ff"/></svg>''',
  ),
  AgentArt(
    'code-reviewer',
    'Code Reviewer',
    r'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><defs><linearGradient id="codeBg" x2="1" y2="1"><stop stop-color="#dff8ee"/><stop offset="1" stop-color="#8cddc1"/></linearGradient><linearGradient id="codeScreen" x2="1" y2="1"><stop stop-color="#243f49"/><stop offset="1" stop-color="#101e2a"/></linearGradient></defs><circle cx="50" cy="50" r="46" fill="url(#codeBg)"/><rect x="17" y="19" width="66" height="61" rx="13" fill="#6fc5a8"/><rect x="20" y="16" width="60" height="60" rx="11" fill="url(#codeScreen)" stroke="#a4f2d5" stroke-width="3"/><path d="m39 35-10 11 10 11M61 35l10 11-10 11M55 32 45 60" fill="none" stroke="#5cf0bd" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/><circle cx="29" cy="25" r="2" fill="#d6fff0"/></svg>''',
  ),
  AgentArt(
    'accounting-agent',
    'Accounting Agent',
    r'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><defs><linearGradient id="accBg" x2="1" y2="1"><stop stop-color="#fff0ce"/><stop offset="1" stop-color="#f8c56c"/></linearGradient><linearGradient id="accCalc" x2="1" y2="1"><stop stop-color="#405b9a"/><stop offset="1" stop-color="#17284d"/></linearGradient></defs><circle cx="50" cy="50" r="46" fill="url(#accBg)"/><g transform="rotate(-7 47 48)"><rect x="24" y="13" width="48" height="72" rx="9" fill="#d49b45"/><rect x="22" y="10" width="46" height="70" rx="8" fill="url(#accCalc)" stroke="#ffdc8b" stroke-width="3"/><rect x="29" y="18" width="32" height="15" rx="3" fill="#70a9ff"/><g fill="#ffbd4a"><rect x="29" y="40" width="8" height="8" rx="2"/><rect x="42" y="40" width="8" height="8" rx="2"/><rect x="55" y="40" width="6" height="8" rx="2"/><rect x="29" y="53" width="8" height="8" rx="2"/><rect x="42" y="53" width="8" height="8" rx="2"/><rect x="55" y="53" width="6" height="8" rx="2"/><rect x="29" y="66" width="8" height="7" rx="2"/><rect x="42" y="66" width="8" height="7" rx="2"/></g></g><ellipse cx="71" cy="79" rx="17" ry="6" fill="#b87514"/><path d="M54 69c0-4 8-7 17-7s17 3 17 7-8 7-17 7-17-3-17-7Zm0 0v10c0 4 8 7 17 7s17-3 17-7V69" fill="#e8a82e" stroke="#fff0a7" stroke-width="2"/><path d="M54 74c0 4 8 7 17 7s17-3 17-7" fill="none" stroke="#b87514" stroke-width="2"/></svg>''',
  ),
  AgentArt(
    'market-researcher',
    'Market Researcher',
    r'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><defs><linearGradient id="marketBg" x2="1" y2="1"><stop stop-color="#f0e5ff"/><stop offset="1" stop-color="#b8a1f6"/></linearGradient></defs><circle cx="50" cy="50" r="46" fill="url(#marketBg)"/><ellipse cx="50" cy="78" rx="32" ry="8" fill="#8061db" opacity=".3"/><rect x="22" y="54" width="14" height="22" rx="4" fill="#3e8dff"/><rect x="42" y="40" width="14" height="36" rx="4" fill="#ee5ca9"/><rect x="62" y="27" width="14" height="49" rx="4" fill="#7a5af8"/><path d="m22 46 22-14 17 2 16-18" fill="none" stroke="#5e39d6" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/><path d="M65 16h12v12" fill="none" stroke="#5e39d6" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/><path d="M22 78h56" stroke="#fff" stroke-width="4" stroke-linecap="round"/></svg>''',
  ),
  AgentArt(
    'prompt-engineer',
    'Prompt Engineer',
    r'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><defs><linearGradient id="promptBg" x2="1" y2="1"><stop stop-color="#eee4ff"/><stop offset="1" stop-color="#b99af4"/></linearGradient><linearGradient id="promptTile" x2="1" y2="1"><stop stop-color="#9a79f2"/><stop offset="1" stop-color="#6040c8"/></linearGradient></defs><circle cx="50" cy="50" r="46" fill="url(#promptBg)"/><rect x="21" y="19" width="58" height="62" rx="16" fill="#a68af2"/><rect x="18" y="16" width="58" height="62" rx="15" fill="url(#promptTile)" stroke="#e5d9ff" stroke-width="3"/><path d="M47 27 53 42 68 48 53 54 47 69 41 54 26 48 41 42Z" fill="#fff7ff"/><path d="m68 21 3 7 7 3-7 3-3 7-3-7-7-3 7-3Z" fill="#c9b8ff"/></svg>''',
  ),
  AgentArt(
    'data-analyst',
    'Data Analyst',
    r'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><defs><linearGradient id="dataBg" x2="1" y2="1"><stop stop-color="#dffaf0"/><stop offset="1" stop-color="#85dfc8"/></linearGradient><linearGradient id="dataDb" x2="1" y2="1"><stop stop-color="#20cbb0"/><stop offset="1" stop-color="#087c79"/></linearGradient></defs><circle cx="50" cy="50" r="46" fill="url(#dataBg)"/><ellipse cx="46" cy="27" rx="23" ry="10" fill="#b5fff0"/><path d="M23 27v42c0 6 10 11 23 11s23-5 23-11V27Z" fill="url(#dataDb)" stroke="#c7fff3" stroke-width="3"/><ellipse cx="46" cy="27" rx="23" ry="10" fill="#40e2c5" stroke="#d2fff4" stroke-width="3"/><path d="M23 42c0 6 10 11 23 11s23-5 23-11M23 57c0 6 10 11 23 11s23-5 23-11" fill="none" stroke="#087e7a" stroke-width="3"/><path d="m59 70 10 8 10-17" fill="none" stroke="#f1fffa" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/></svg>''',
  ),
  AgentArt(
    'support-lead',
    'Support Lead',
    r'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><defs><linearGradient id="supportBg" x2="1" y2="1"><stop stop-color="#fff1c8"/><stop offset="1" stop-color="#f6c45f"/></linearGradient><linearGradient id="supportEar" x2="1" y2="1"><stop stop-color="#45516b"/><stop offset="1" stop-color="#1c263b"/></linearGradient></defs><circle cx="50" cy="50" r="46" fill="url(#supportBg)"/><path d="M24 52V44a26 26 0 0 1 52 0v12" fill="none" stroke="#1d2940" stroke-width="9" stroke-linecap="round"/><rect x="17" y="44" width="18" height="27" rx="8" fill="url(#supportEar)"/><rect x="65" y="44" width="18" height="27" rx="8" fill="url(#supportEar)"/><path d="M75 67c0 10-10 14-21 14" fill="none" stroke="#35425a" stroke-width="5" stroke-linecap="round"/><rect x="47" y="75" width="15" height="9" rx="4" fill="#35425a"/></svg>''',
  ),
  AgentArt(
    'security-sentinel',
    'Security Sentinel',
    r'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><defs><linearGradient id="secBg" x2="1" y2="1"><stop stop-color="#dfe9ff"/><stop offset="1" stop-color="#8da9f4"/></linearGradient><linearGradient id="secLock" x2="1" y2="1"><stop stop-color="#3454a4"/><stop offset="1" stop-color="#152552"/></linearGradient></defs><circle cx="50" cy="50" r="46" fill="url(#secBg)"/><path d="M32 44V34a18 18 0 0 1 36 0v10" fill="none" stroke="#263d78" stroke-width="9" stroke-linecap="round"/><rect x="22" y="40" width="56" height="43" rx="12" fill="url(#secLock)" stroke="#c7d7ff" stroke-width="3"/><circle cx="50" cy="58" r="6" fill="#8fe9ff"/><path d="M50 62v8" stroke="#8fe9ff" stroke-width="5" stroke-linecap="round"/></svg>''',
  ),
  AgentArt(
    'project-manager',
    'Project Manager',
    r'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><defs><linearGradient id="pmBg" x2="1" y2="1"><stop stop-color="#e4f7e7"/><stop offset="1" stop-color="#8bd4a4"/></linearGradient></defs><circle cx="50" cy="50" r="46" fill="url(#pmBg)"/><circle cx="50" cy="50" r="29" fill="#f7fff7" stroke="#78bd8d" stroke-width="4"/><circle cx="50" cy="50" r="21" fill="#d9f5e0"/><path d="m61 34-7 22-18 10 7-22Z" fill="#218b59" stroke="#fff" stroke-width="3" stroke-linejoin="round"/><circle cx="50" cy="50" r="4" fill="#fff"/></svg>''',
  ),
  AgentArt(
    'content-creator',
    'Content Creator',
    r'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><defs><linearGradient id="contentBg" x2="1" y2="1"><stop stop-color="#ffe5df"/><stop offset="1" stop-color="#f7a48d"/></linearGradient></defs><circle cx="50" cy="50" r="46" fill="url(#contentBg)"/><rect x="22" y="19" width="56" height="62" rx="12" fill="#fff8f4" stroke="#ffd0c4" stroke-width="3"/><path d="M34 36h29M34 46h22M34 56h17" stroke="#e99a85" stroke-width="4" stroke-linecap="round"/><g transform="rotate(38 64 62)"><rect x="58" y="42" width="12" height="35" rx="4" fill="#d84c6f"/><path d="M58 42h12l-6-12Z" fill="#ffd66d"/><path d="M58 69h12" stroke="#fff0f3" stroke-width="3"/></g></svg>''',
  ),
  AgentArt(
    'social-media-manager',
    'Social Media Manager',
    r'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><defs><linearGradient id="socialBg" x2="1" y2="1"><stop stop-color="#fbe3f2"/><stop offset="1" stop-color="#e59bd0"/></linearGradient></defs><circle cx="50" cy="50" r="46" fill="url(#socialBg)"/><path d="M18 27a12 12 0 0 1 12-12h39a12 12 0 0 1 12 12v23a12 12 0 0 1-12 12H45L29 75V62a12 12 0 0 1-11-12Z" fill="#fff8ff" stroke="#d87dbb" stroke-width="3"/><circle cx="36" cy="39" r="4" fill="#c24b9d"/><circle cx="50" cy="39" r="4" fill="#c24b9d"/><circle cx="64" cy="39" r="4" fill="#c24b9d"/><path d="M39 70h30a9 9 0 0 1 9 9v4H48l-9 7Z" fill="#8b5de8" stroke="#e7d9ff" stroke-width="3"/></svg>''',
  ),
  AgentArt(
    'research-librarian',
    'Research Librarian',
    r'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><defs><linearGradient id="libBg" x2="1" y2="1"><stop stop-color="#e5f2ff"/><stop offset="1" stop-color="#9bc9f5"/></linearGradient></defs><circle cx="50" cy="50" r="46" fill="url(#libBg)"/><rect x="20" y="24" width="18" height="53" rx="4" fill="#f1a84e"/><rect x="41" y="17" width="18" height="60" rx="4" fill="#477bd5"/><rect x="62" y="29" width="18" height="48" rx="4" fill="#37b89b"/><path d="M25 35h8M46 29h8M67 39h8" stroke="#fff" stroke-width="3" stroke-linecap="round"/><path d="M17 79h66" stroke="#fff" stroke-width="5" stroke-linecap="round"/></svg>''',
  ),
  AgentArt(
    'automation-engineer',
    'Automation Engineer',
    r'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><defs><linearGradient id="autoBg" x2="1" y2="1"><stop stop-color="#d9f8fb"/><stop offset="1" stop-color="#75cdd7"/></linearGradient></defs><circle cx="50" cy="50" r="46" fill="url(#autoBg)"/><g transform="translate(31 34)"><path d="M0-14h8l3 7 7 2 6-4 6 6-4 6 2 7 7 3v8l-7 3-2 7 4 6-6 6-6-4-7 2-3 7H0l-3-7-7-2-6 4-6-6 4-6-2-7-7-3v-8l7-3 2-7-4-6 6-6 6 4 7-2Z" transform="scale(.75)" fill="#168d9c"/><circle r="8" fill="#d9fbff"/></g><g transform="translate(66 63) scale(.68)"><path d="M0-14h8l3 7 7 2 6-4 6 6-4 6 2 7 7 3v8l-7 3-2 7 4 6-6 6-6-4-7 2-3 7H0l-3-7-7-2-6 4-6-6 4-6-2-7-7-3v-8l7-3 2-7-4-6 6-6 6 4 7-2Z" fill="#146d85"/><circle r="8" fill="#d9fbff"/></g></svg>''',
  ),
  AgentArt(
    'ux-designer',
    'UX Designer',
    r'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><defs><linearGradient id="uxBg" x2="1" y2="1"><stop stop-color="#fff0d8"/><stop offset="1" stop-color="#f5c78d"/></linearGradient></defs><circle cx="50" cy="50" r="46" fill="url(#uxBg)"/><rect x="19" y="18" width="62" height="48" rx="8" fill="#fffdf7" stroke="#e7b878" stroke-width="3"/><rect x="26" y="26" width="21" height="30" rx="4" fill="#8bd7c2"/><rect x="52" y="26" width="21" height="8" rx="3" fill="#f28c83"/><rect x="52" y="39" width="21" height="17" rx="3" fill="#b29af2"/><path d="M39 67v9M61 67v9M31 77h38" stroke="#a46d36" stroke-width="5" stroke-linecap="round"/><circle cx="36" cy="40" r="5" fill="#fff" opacity=".7"/></svg>''',
  ),
  AgentArt(
    'devops-engineer',
    'DevOps Engineer',
    r'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><defs><linearGradient id="devopsBg" x2="1" y2="1"><stop stop-color="#e4eaff"/><stop offset="1" stop-color="#a1b3f7"/></linearGradient></defs><circle cx="50" cy="50" r="46" fill="url(#devopsBg)"/><path d="M25 67a15 15 0 0 1-1-30 22 22 0 0 1 41-5 17 17 0 0 1 9 32H25Z" fill="#f8fbff" stroke="#7187dc" stroke-width="3"/><path d="m40 47-8 8 8 8M60 47l8 8-8 8M55 43l-10 24" fill="none" stroke="#4967c5" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><circle cx="50" cy="25" r="3" fill="#fff"/></svg>''',
  ),
  AgentArt(
    'product-strategist',
    'Product Strategist',
    r'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><defs><linearGradient id="prodBg" x2="1" y2="1"><stop stop-color="#ffe8df"/><stop offset="1" stop-color="#f6ad9b"/></linearGradient></defs><circle cx="50" cy="50" r="46" fill="url(#prodBg)"/><circle cx="48" cy="53" r="29" fill="#fff6f1" stroke="#e68d79" stroke-width="4"/><circle cx="48" cy="53" r="19" fill="#f5b7a8" stroke="#fff" stroke-width="4"/><circle cx="48" cy="53" r="8" fill="#d95b52"/><path d="m49 52 28-28M63 24h14v14" fill="none" stroke="#9d393d" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/></svg>''',
  ),
  AgentArt(
    'legal-advisor',
    'Legal Advisor',
    r'''<svg xmlns="http://www.w3.org/2000/svg" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><defs><linearGradient id="legalBg" x2="1" y2="1"><stop stop-color="#e8ecff"/><stop offset="1" stop-color="#9aa8e8"/></linearGradient><linearGradient id="legalBeam" x2="1" y2="1"><stop stop-color="#3b4a7a"/><stop offset="1" stop-color="#1a2340"/></linearGradient></defs><circle cx="50" cy="50" r="46" fill="url(#legalBg)"/><circle cx="50" cy="50" r="40" fill="#fff" opacity=".16"/><path d="M50 18v50" stroke="url(#legalBeam)" stroke-width="6" stroke-linecap="round"/><circle cx="50" cy="17" r="6" fill="#f6d68a" stroke="#2b3560" stroke-width="2"/><path d="M22 34h56" stroke="url(#legalBeam)" stroke-width="6" stroke-linecap="round"/><path d="M22 34 12 56h20Z" fill="#f6d68a" stroke="#2b3560" stroke-width="3" stroke-linejoin="round"/><path d="M78 34 68 56h20Z" fill="#f6d68a" stroke="#2b3560" stroke-width="3" stroke-linejoin="round"/><path d="M14 56a8 8 0 0 0 16 0Z" fill="#e0b45f"/><path d="M70 56a8 8 0 0 0 16 0Z" fill="#e0b45f"/><rect x="34" y="68" width="32" height="9" rx="4" fill="#2b3560"/><rect x="28" y="77" width="44" height="8" rx="4" fill="#3b4a7a"/></svg>''',
  ),
];

/// id -> avatar, for O(1) lookup by the roster.
Map<String, AgentArt> get kAgentArtIndex => <String, AgentArt>{
      for (final AgentArt a in kAgentArtLibrary) a.id: a,
    };

