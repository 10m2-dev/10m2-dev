// .github/scripts/generate-productive-time.mjs
// (1) 시간별 커밋: README 마커에 텍스트로 주입
// (2) Streak: output/streak.svg 디자인 카드 생성 (README에서 <img>로 참조)
// private 반영: "Include private contributions" 설정 + repo 스코프 PAT
// - GH_TOKEN: repo 스코프 PAT / TIMEZONE: 예) Asia/Seoul
// CI(GITHUB_ACTIONS)에서는 이 스크립트가 직접 커밋/푸시한다.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { execSync } from "node:child_process";

const TOKEN = process.env.GH_TOKEN;
const TZ = process.env.TIMEZONE || "Asia/Seoul";
const README = "README.md";
const PT_START = "<!-- PRODUCTIVE-TIME:START -->";
const PT_END = "<!-- PRODUCTIVE-TIME:END -->";
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

const { viewer } = await gql(`query { viewer { id login createdAt } }`);

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
// 시간대별 활동 = SVG 박스 카드(Streak과 동일 톤·14px). README는 <picture>로 라이트/다크 참조.
const ptBlock = `${PT_START}\n\n<picture>\n  <source media="(prefers-color-scheme: dark)"  srcset="./output/productive-dark.svg">\n  <source media="(prefers-color-scheme: light)" srcset="./output/productive-light.svg">\n  <img src="./output/productive-dark.svg" alt="when am I most active" />\n</picture>\n\n${PT_END}`;

// ============ (2) Streak (디자인 SVG) ============
// 가입연도부터 연도별로 기여 캘린더를 모아 누적(all-time)
const createdYear = new Date(viewer.createdAt).getUTCFullYear();
const nowYear = new Date().getUTCFullYear();
const nowISO = new Date().toISOString();
let days = [];
for (let y = createdYear; y <= nowYear; y++) {
  const from = `${y}-01-01T00:00:00Z`;
  const to = y === nowYear ? nowISO : `${y}-12-31T23:59:59Z`;
  const c = (await gql(
    `query($from: DateTime!, $to: DateTime!) {
      viewer { contributionsCollection(from: $from, to: $to) {
        contributionCalendar { weeks { contributionDays { date contributionCount } } } } }
    }`,
    { from, to }
  )).viewer.contributionsCollection.contributionCalendar;
  days.push(...c.weeks.flatMap((w) => w.contributionDays));
}
days = [...new Map(days.map((d) => [d.date, d])).values()].sort((a, b) => a.date.localeCompare(b.date)); // 중복 제거·오름차순
const totalContrib = days.reduce((s, d) => s + d.contributionCount, 0);
const stats = {
  bestDay: days.reduce((m, d) => Math.max(m, d.contributionCount), 0),
  activeDays: days.filter((d) => d.contributionCount > 0).length,
  avgPerDay: (totalContrib / days.length).toFixed(1),
};

// 최장 연속 + 구간
let longest = 0, run = 0, runStart = 0, lStart = 0, lEnd = 0;
for (let i = 0; i < days.length; i++) {
  if (days[i].contributionCount > 0) {
    if (run === 0) runStart = i;
    run++;
    if (run > longest) { longest = run; lStart = runStart; lEnd = i; }
  } else run = 0;
}
// 현재 연속 + 구간 (오늘 0이면 어제 기준)
let endIdx = days.length - 1;
if (days[endIdx].contributionCount === 0) endIdx--;
let current = 0, cStart = endIdx + 1;
for (let i = endIdx; i >= 0; i--) {
  if (days[i]?.contributionCount > 0) { current++; cStart = i; } else break;
}

const fFull = (iso) => { const [y, m, d] = iso.split("-"); return `${y}.${m}.${d}`; };
const fMD = (iso) => { const [, m, d] = iso.split("-"); return `${m}.${d}`; };
const totalRange = `${fFull(days[0].date)} – Now`;
const currentRange = current === 0 ? "—"
  : current === 1 ? fFull(days[endIdx].date)
  : `${fMD(days[cStart].date)} – ${fMD(days[endIdx].date)}`;
const longestRange = longest === 0 ? "—"
  : longest === 1 ? fFull(days[lStart].date)
  : `${fMD(days[lStart].date)} – ${fMD(days[lEnd].date)}`;

const W = 846, H = 165, cx = [70.5, 211.5, 352.5, 493.5, 634.5, 775.5];
const themes = {
  dark:  { bg: "#1a1b27", border: "#29304d", div: "#29304d", num: "#c0caf5", label: "#7aa2f7", date: "#565f89", accent: "#ff9e64", track: "#2a3152" },
  light: { bg: "#ffffff", border: "#d0d7de", div: "#d0d7de", num: "#1f2328", label: "#0969da", date: "#57606a", accent: "#e8590c", track: "#eaeef2" },
};
const buildStreak = (C) => `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="'Segoe UI', Ubuntu, Helvetica, Arial, sans-serif">
  <rect x="1" y="1" width="${W - 2}" height="${H - 2}" rx="12" fill="${C.bg}" stroke="${C.border}"/>
  <line x1="141" y1="30" x2="141" y2="135" stroke="${C.div}"/>
  <line x1="282" y1="30" x2="282" y2="135" stroke="${C.div}"/>
  <line x1="423" y1="30" x2="423" y2="135" stroke="${C.div}"/>
  <line x1="564" y1="30" x2="564" y2="135" stroke="${C.div}"/>
  <line x1="705" y1="30" x2="705" y2="135" stroke="${C.div}"/>

  <text x="${cx[0]}" y="70" text-anchor="middle" font-size="27" font-weight="700" fill="${C.num}">${totalContrib}</text>
  <text x="${cx[0]}" y="100" text-anchor="middle" font-size="12" fill="${C.label}">Total Contributions</text>
  <text x="${cx[0]}" y="120" text-anchor="middle" font-size="10" fill="${C.date}">${totalRange}</text>

  <text x="${cx[1]}" y="32" text-anchor="middle" font-size="16">🔥</text>
  <circle cx="${cx[1]}" cy="64" r="26" fill="none" stroke="${C.accent}" stroke-width="3"/>
  <text x="${cx[1]}" y="72" text-anchor="middle" font-size="23" font-weight="700" fill="${C.accent}">${current}</text>
  <text x="${cx[1]}" y="108" text-anchor="middle" font-size="12" font-weight="600" fill="${C.accent}">Current Streak</text>
  <text x="${cx[1]}" y="127" text-anchor="middle" font-size="10" fill="${C.date}">${currentRange}</text>

  <text x="${cx[2]}" y="70" text-anchor="middle" font-size="27" font-weight="700" fill="${C.num}">${longest}</text>
  <text x="${cx[2]}" y="100" text-anchor="middle" font-size="12" fill="${C.label}">Longest Streak</text>
  <text x="${cx[2]}" y="120" text-anchor="middle" font-size="10" fill="${C.date}">${longestRange}</text>

  <text x="${cx[3]}" y="70" text-anchor="middle" font-size="27" font-weight="700" fill="${C.accent}">${stats.bestDay}</text>
  <text x="${cx[3]}" y="100" text-anchor="middle" font-size="12" fill="${C.label}">Best Day</text>

  <text x="${cx[4]}" y="70" text-anchor="middle" font-size="27" font-weight="700" fill="${C.num}">${stats.activeDays}</text>
  <text x="${cx[4]}" y="100" text-anchor="middle" font-size="12" fill="${C.label}">Active Days</text>

  <text x="${cx[5]}" y="70" text-anchor="middle" font-size="27" font-weight="700" fill="${C.num}">${stats.avgPerDay}</text>
  <text x="${cx[5]}" y="100" text-anchor="middle" font-size="12" fill="${C.label}">Avg / Day</text>
</svg>`;

// 시간대별 활동 SVG 박스 카드(14px, Streak과 동일 톤). 바 = 트랙 rect + 채움 rect.
const buildProductive = (C) => {
  const barX = 402, barW = 300, barH = 12, row0 = 46, rowH = 38;
  const PH = row0 * 2 + (ptRows.length - 1) * rowH; // 206
  const rows = ptRows.map((r, i) => {
    const cy = row0 + i * rowH;
    const fillW = Math.max(4, (barW * r.percent) / 100).toFixed(1);
    return `
  <text x="46" y="${cy + 6}" text-anchor="middle" font-size="17">${r.emoji}</text>
  <text x="74" y="${cy + 5}" font-size="14" font-weight="600" fill="${C.num}">${r.label}</text>
  <text x="184" y="${cy + 5}" font-size="13" fill="${C.date}">${r.time}</text>
  <text x="374" y="${cy + 5}" text-anchor="end" font-size="13" fill="${C.num}">${r.n} commits</text>
  <rect x="${barX}" y="${cy - barH / 2}" width="${barW}" height="${barH}" rx="6" fill="${C.track}"/>
  <rect x="${barX}" y="${cy - barH / 2}" width="${fillW}" height="${barH}" rx="6" fill="${C.accent}"/>
  <text x="806" y="${cy + 5}" text-anchor="end" font-size="14" font-weight="700" fill="${C.accent}">${r.percent.toFixed(1)}%</text>`;
  }).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="846" height="${PH}" viewBox="0 0 846 ${PH}" font-family="'Segoe UI', Ubuntu, Helvetica, Arial, sans-serif">
  <rect x="1" y="1" width="844" height="${PH - 2}" rx="12" fill="${C.bg}" stroke="${C.border}"/>${rows}
</svg>`;
};

// ============ 출력 ============
let readme = readFileSync(README, "utf8");
const re = new RegExp(`${PT_START}[\\s\\S]*?${PT_END}`);
if (!re.test(readme)) { console.error("PT markers not found"); process.exit(1); }
readme = readme.replace(re, ptBlock);
writeFileSync(README, readme);
mkdirSync("output", { recursive: true });
writeFileSync("output/streak-dark.svg", buildStreak(themes.dark));
writeFileSync("output/streak-light.svg", buildStreak(themes.light));
writeFileSync("output/productive-dark.svg", buildProductive(themes.dark));
writeFileSync("output/productive-light.svg", buildProductive(themes.light));
console.log("updated", { buckets, total, current, longest, totalContrib, currentRange, longestRange });

// CI: 직접 커밋/푸시
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
