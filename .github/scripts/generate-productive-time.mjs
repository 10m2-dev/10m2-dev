// .github/scripts/generate-productive-time.mjs
// 두 카드를 라이트/다크 SVG로 생성 (README는 <picture>로 참조):
//   output/productive-{dark,light}.svg  — 시간별 커밋
//   output/streak-{dark,light}.svg      — Streak
// private 반영: "Include private contributions" 설정 + repo 스코프 PAT
// - GH_TOKEN: repo 스코프 PAT / TIMEZONE: 예) Asia/Seoul
// CI(GITHUB_ACTIONS)에서는 이 스크립트가 직접 커밋/푸시한다.
import { writeFileSync, mkdirSync } from "node:fs";
import { execSync } from "node:child_process";

const TOKEN = process.env.GH_TOKEN;
const TZ = process.env.TIMEZONE || "Asia/Seoul";
if (!TOKEN) {
  console.error("GH_TOKEN is required");
  process.exit(1);
}

async function gql(query, variables = {}) {
  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: { Authorization: `bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (json.errors) throw new Error(JSON.stringify(json.errors));
  return json.data;
}

const { viewer } = await gql(`query { viewer { id login } }`);
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// ============ (1) 시간별 커밋 ============
const buckets = { morning: 0, daytime: 0, evening: 0, night: 0 };
const hourFmt = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "2-digit", hourCycle: "h23" });
const bucketOf = (h) =>
  h >= 6 && h < 12 ? "morning" : h >= 12 && h < 18 ? "daytime" : h >= 18 && h < 24 ? "evening" : "night";

let after = null, pages = 0;
do {
  const data = await gql(
    `query($after: String, $id: ID!) {
      viewer {
        repositories(first: 50, after: $after, isFork: false, ownerAffiliations: [OWNER],
                     orderBy: {field: PUSHED_AT, direction: DESC}) {
          nodes { defaultBranchRef { target { ... on Commit {
            history(first: 100, author: {id: $id}) { nodes { committedDate } } } } } }
          pageInfo { hasNextPage endCursor }
        }
      }
    }`,
    { after, id: viewer.id }
  );
  const repos = data.viewer.repositories;
  for (const repo of repos.nodes)
    for (const c of repo.defaultBranchRef?.target?.history?.nodes ?? [])
      buckets[bucketOf(Number(hourFmt.format(new Date(c.committedDate))))]++;
  after = repos.pageInfo.hasNextPage ? repos.pageInfo.endCursor : null;
} while (after && ++pages < 4);

const total = Object.values(buckets).reduce((a, b) => a + b, 0) || 1;
const ptRows = [
  { emoji: "🌅", label: "Morning", time: "06-12", n: buckets.morning },
  { emoji: "🌞", label: "Daytime", time: "12-18", n: buckets.daytime },
  { emoji: "🌆", label: "Evening", time: "18-24", n: buckets.evening },
  { emoji: "🌙", label: "Night",   time: "00-06", n: buckets.night },
].map((r) => ({ ...r, percent: (r.n / total) * 100 }));

// ============ (2) Streak ============
const cal = (await gql(`query {
  viewer { contributionsCollection { contributionCalendar {
    totalContributions weeks { contributionDays { date contributionCount } } } } }
}`)).viewer.contributionsCollection.contributionCalendar;
const days = cal.weeks.flatMap((w) => w.contributionDays);
const totalContrib = cal.totalContributions;

let longest = 0, run = 0, runStart = 0, lStart = 0, lEnd = 0;
for (let i = 0; i < days.length; i++) {
  if (days[i].contributionCount > 0) {
    if (run === 0) runStart = i;
    run++;
    if (run > longest) { longest = run; lStart = runStart; lEnd = i; }
  } else run = 0;
}
let endIdx = days.length - 1;
if (days[endIdx].contributionCount === 0) endIdx--;
let current = 0, cStart = endIdx + 1;
for (let i = endIdx; i >= 0; i--) {
  if (days[i]?.contributionCount > 0) { current++; cStart = i; } else break;
}
const fFull = (iso) => { const [y, m, d] = iso.split("-"); return `${y}.${m}.${d}`; };
const fMD = (iso) => { const [, m, d] = iso.split("-"); return `${m}.${d}`; };
const totalRange = `${fFull(days[0].date)} – Now`;
const currentRange = current === 0 ? "—" : current === 1 ? fFull(days[endIdx].date)
  : `${fMD(days[cStart].date)} – ${fMD(days[endIdx].date)}`;
const longestRange = longest === 0 ? "—" : longest === 1 ? fFull(days[lStart].date)
  : `${fMD(days[lStart].date)} – ${fMD(days[lEnd].date)}`;

// ============ 테마 ============
const T = {
  dark:  { bg:"#1a1b27", border:"#29304d", div:"#29304d", num:"#c0caf5", accent:"#ff9e64",
           rank:"#565f89", text:"#c0caf5", muted:"#7982a9", label:"#7aa2f7", track:"#29304d", fill:"#7aa2f7" },
  light: { bg:"#ffffff", border:"#d0d7de", div:"#d0d7de", num:"#1f2328", accent:"#e8590c",
           rank:"#8b949e", text:"#1f2328", muted:"#57606a", label:"#0969da", track:"#eaeef2", fill:"#0969da" },
};

// ============ 시간별 SVG ============
const buildProd = (C) => {
  const W = 580, pad = 16, rowH = 34, barX = 360, barW = 150, barH = 8;
  const H = pad * 2 + ptRows.length * rowH;
  const rows = ptRows.map((r, i) => {
    const cyc = pad + rowH / 2 + i * rowH;
    const b = cyc + 4;
    const fillW = Math.max(0, Math.min(barW, (r.percent / 100) * barW));
    return `
  <text x="24" y="${b}" font-size="13" fill="${C.rank}">${i + 1}</text>
  <text x="44" y="${b}" font-size="15">${r.emoji}</text>
  <text x="70" y="${b}" font-size="14" fill="${C.text}">${esc(r.label)}</text>
  <text x="160" y="${b}" font-size="12" fill="${C.label}" font-family="ui-monospace, monospace">${r.time}</text>
  <text x="282" y="${b}" font-size="13" fill="${C.text}" text-anchor="end" font-family="ui-monospace, monospace">${r.n}</text>
  <text x="288" y="${b}" font-size="12" fill="${C.muted}">commits</text>
  <rect x="${barX}" y="${cyc - barH / 2}" width="${barW}" height="${barH}" rx="4" fill="${C.track}"/>
  <rect x="${barX}" y="${cyc - barH / 2}" width="${fillW.toFixed(1)}" height="${barH}" rx="4" fill="${C.fill}"/>
  <text x="${W - 24}" y="${b}" font-size="13" fill="${C.text}" text-anchor="end" font-family="ui-monospace, monospace">${r.percent.toFixed(1)}%</text>`;
  }).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="'Segoe UI', Ubuntu, Helvetica, Arial, sans-serif">
  <rect x="1" y="1" width="${W - 2}" height="${H - 2}" rx="12" fill="${C.bg}" stroke="${C.border}"/>${rows}
</svg>`;
};

// ============ Streak SVG ============
const W = 495, H = 165, cx = [82.5, 247.5, 412.5];
const buildStreak = (C) => `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="'Segoe UI', Ubuntu, Helvetica, Arial, sans-serif">
  <rect x="1" y="1" width="${W - 2}" height="${H - 2}" rx="12" fill="${C.bg}" stroke="${C.border}"/>
  <line x1="165" y1="28" x2="165" y2="138" stroke="${C.div}"/>
  <line x1="330" y1="28" x2="330" y2="138" stroke="${C.div}"/>

  <text x="${cx[0]}" y="72" text-anchor="middle" font-size="32" font-weight="700" fill="${C.num}">${totalContrib}</text>
  <text x="${cx[0]}" y="104" text-anchor="middle" font-size="13" fill="${C.label}">Total Contributions</text>
  <text x="${cx[0]}" y="126" text-anchor="middle" font-size="11" fill="${C.date}">${totalRange}</text>

  <text x="${cx[1]}" y="30" text-anchor="middle" font-size="18">🔥</text>
  <circle cx="${cx[1]}" cy="62" r="30" fill="none" stroke="${C.accent}" stroke-width="3"/>
  <text x="${cx[1]}" y="71" text-anchor="middle" font-size="27" font-weight="700" fill="${C.accent}">${current}</text>
  <text x="${cx[1]}" y="112" text-anchor="middle" font-size="13" font-weight="600" fill="${C.accent}">Current Streak</text>
  <text x="${cx[1]}" y="132" text-anchor="middle" font-size="11" fill="${C.date}">${currentRange}</text>

  <text x="${cx[2]}" y="72" text-anchor="middle" font-size="32" font-weight="700" fill="${C.num}">${longest}</text>
  <text x="${cx[2]}" y="104" text-anchor="middle" font-size="13" fill="${C.label}">Longest Streak</text>
  <text x="${cx[2]}" y="126" text-anchor="middle" font-size="11" fill="${C.date}">${longestRange}</text>
</svg>`;

// ============ 출력 ============
mkdirSync("output", { recursive: true });
writeFileSync("output/productive-dark.svg", buildProd(T.dark));
writeFileSync("output/productive-light.svg", buildProd(T.light));
writeFileSync("output/streak-dark.svg", buildStreak(T.dark));
writeFileSync("output/streak-light.svg", buildStreak(T.light));
console.log("wrote 4 svgs", { buckets, total, current, longest, totalContrib });

if (process.env.GITHUB_ACTIONS) {
  execSync('git config user.name "github-actions[bot]"');
  execSync('git config user.email "41898282+github-actions[bot]@users.noreply.github.com"');
  execSync("git add -A");
  try {
    execSync('git commit -m "chore: update profile cards"', { stdio: "inherit" });
    execSync("git push", { stdio: "inherit" });
  } catch {
    console.log("nothing to commit");
  }
}
