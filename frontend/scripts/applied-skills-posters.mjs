/**
 * What the two Microsoft Learn posters say once their PDF text is read
 * (moved out of update-applied-skills.mjs by #1845): the certification
 * codes and titles on the Certifications poster, and which of the known
 * applied skill titles the Applied Skills poster carries.
 */

// Titles only — the poster's text runs these codes into their neighbours.
// Lifecycle is never asserted here: an override that said "(Beta)" for AB-620
// kept telling rule 3 the exam was in beta after Microsoft had made it GA.
const CERTIFICATION_POSTER_TITLE_OVERRIDES = {
  'AB-100': 'Agentic AI Business Solutions Architect',
  'AB-620': 'AI Agent Builder Associate',
  'AB-900': 'Microsoft 365 Copilot and Agent Administration Fundamentals',
  'AZ-801': 'Windows Server Hybrid Administrator Associate',
  'AI-901': 'Azure AI Fundamentals',
};

export const POSTER_ONLY_APPLIED_SKILLS = [
  {
    id: 'apl-openai-semantic-kernel',
    slug: 'develop-generative-ai-apps-azure-openai-semantic-kernel',
    code: 'APL-SK',
    officialCode: 'develop-generative-ai-apps-azure-openai-semantic-kernel',
    title: 'Develop generative AI apps with Azure OpenAI and Semantic Kernel',
    area: 'AI',
    level: 'Intermediate',
    status: 'active',
    description:
      'Build generative AI applications using Azure OpenAI Service and Semantic Kernel SDK, including plugins and orchestration patterns.',
    learnUrl:
      'https://learn.microsoft.com/en-us/credentials/applied-skills/develop-generative-ai-apps-azure-openai-semantic-kernel/',
  },
  {
    id: 'apl-m365-copilot-declarative',
    slug: 'extend-microsoft-365-copilot-with-declarative-agents',
    code: 'APL-M365D',
    officialCode: 'extend-microsoft-365-copilot-with-declarative-agents',
    title: 'Extend Microsoft 365 Copilot with declarative agents by using Visual Studio Code',
    area: 'AI',
    level: 'Intermediate',
    status: 'active',
    description:
      'Build declarative agents for Microsoft 365 Copilot using Visual Studio Code to extend AI capabilities.',
    learnUrl:
      'https://learn.microsoft.com/en-us/credentials/applied-skills/extend-microsoft-365-copilot-with-declarative-agents/',
  },
];

export function extractAppliedPosterTitles(text) {
  const normalized = text.replace(/\s+/g, ' ').trim();
  const titles = [
    ...POSTER_ONLY_APPLIED_SKILLS.map((skill) => skill.title),
    'Accelerate app development by using GitHub Copilot',
    'Build a generative AI chat app',
    'Create an AI agent',
    'Secure AI solutions in the cloud',
    'Streamline business workflows with AI chat',
  ];
  return titles.filter((title) =>
    normalized.toLowerCase().includes(title.toLowerCase().replace('AI-assisted', 'app'))
  );
}

/** An exam code as the poster prints it: two to four letters, a dash, three or four digits. */
const POSTER_CODE = /\b[A-Z]{2,4}-\d{3,4}\b/;

/** Poster lines that head a column or a band, never part of a title. */
const POSTER_STOP_LINES = new Set([
  'Role-based',
  'Specialty',
  'Business',
  'Fundamentals',
  'Expand your technical skill set',
  'Deepen your technical skills and',
  'manage industry solutions',
  'Expand your AI skills',
  'for business roles',
  'Master the basics',
  'AI Business SolutionsSecurityCloud & AI Platforms',
]);

/**
 * The title printed above the code on line `index`: up to eight lines,
 * walking back until another code or a heading.
 */
function titleAbove(lines, index) {
  const parts = [];
  for (let cursor = index - 1; cursor >= Math.max(0, index - 8); cursor -= 1) {
    if (POSTER_CODE.test(lines[cursor]) || POSTER_STOP_LINES.has(lines[cursor])) break;
    parts.unshift(lines[cursor]);
  }
  return parts.join(' ').trim();
}

export function extractCertificationPosterEntries(text) {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const entries = new Map();

  lines.forEach((line, index) => {
    const code = line.match(POSTER_CODE)?.[0];
    if (!code) return;
    const title = CERTIFICATION_POSTER_TITLE_OVERRIDES[code] || titleAbove(lines, index);
    if (title) entries.set(code, { code, title });
  });

  // The overrides repair titles on a poster that parsed; applied to a poster
  // that parsed to nothing they would turn an empty source into five entries,
  // and rule 2 would never fire.
  if (entries.size > 0) {
    for (const [code, title] of Object.entries(CERTIFICATION_POSTER_TITLE_OVERRIDES)) {
      entries.set(code, { code, title });
    }
  }

  return [...entries.values()].sort((a, b) => a.code.localeCompare(b.code));
}
