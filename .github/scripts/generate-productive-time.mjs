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
const MONO = "ui-monospace, SFMono-Regular, 'SF Mono', Consolas, 'Liberation Mono', Menlo, monospace";
const SHX = 8, SHY = 8; // 브루탈리즘 하드 오프셋 그림자
const themes = {
  dark:  { bg: "#161b22", border: "#ffffff", shadow: "#ffffff", ink: "#ffffff", num: "#ffffff", label: "#ffffff", date: "#8b949e", accent: "#ffffff", track: "#30363d" },
  light: { bg: "#ffffff", border: "#000000", shadow: "#000000", ink: "#000000", num: "#000000", label: "#000000", date: "#57606a", accent: "#000000", track: "#d0d0d0" },
};
const buildStreak = (C) => `<svg xmlns="http://www.w3.org/2000/svg" width="${W + SHX}" height="${H + SHY}" viewBox="0 0 ${W + SHX} ${H + SHY}" font-family="${MONO}">
  <rect x="${1.5 + SHX}" y="${1.5 + SHY}" width="843" height="162" fill="${C.shadow}"/>
  <rect x="1.5" y="1.5" width="843" height="162" fill="${C.bg}" stroke="${C.border}" stroke-width="3"/>
  <line x1="141" y1="22" x2="141" y2="143" stroke="${C.border}" stroke-width="2"/>
  <line x1="282" y1="22" x2="282" y2="143" stroke="${C.border}" stroke-width="2"/>
  <line x1="423" y1="22" x2="423" y2="143" stroke="${C.border}" stroke-width="2"/>
  <line x1="564" y1="22" x2="564" y2="143" stroke="${C.border}" stroke-width="2"/>
  <line x1="705" y1="22" x2="705" y2="143" stroke="${C.border}" stroke-width="2"/>

  <text x="${cx[0]}" y="70" text-anchor="middle" font-size="27" font-weight="700" fill="${C.num}">${totalContrib}</text>
  <text x="${cx[0]}" y="100" text-anchor="middle" font-size="10.5" font-weight="700" letter-spacing="0.5" fill="${C.label}">CONTRIBUTIONS</text>
  <text x="${cx[0]}" y="120" text-anchor="middle" font-size="9" fill="${C.date}">${totalRange}</text>

  <rect x="${cx[1] - 24}" y="40" width="48" height="48" fill="none" stroke="${C.accent}" stroke-width="3"/>
  <text x="${cx[1]}" y="72" text-anchor="middle" font-size="22" font-weight="700" fill="${C.accent}">${current}</text>
  <text x="${cx[1]}" y="108" text-anchor="middle" font-size="10.5" font-weight="700" letter-spacing="0.5" fill="${C.accent}">CURRENT STREAK</text>
  <text x="${cx[1]}" y="127" text-anchor="middle" font-size="9" fill="${C.date}">${currentRange}</text>

  <text x="${cx[2]}" y="70" text-anchor="middle" font-size="27" font-weight="700" fill="${C.num}">${longest}</text>
  <text x="${cx[2]}" y="100" text-anchor="middle" font-size="10.5" font-weight="700" letter-spacing="0.5" fill="${C.label}">LONGEST STREAK</text>
  <text x="${cx[2]}" y="120" text-anchor="middle" font-size="9" fill="${C.date}">${longestRange}</text>

  <text x="${cx[3]}" y="70" text-anchor="middle" font-size="27" font-weight="700" fill="${C.accent}">${stats.bestDay}</text>
  <text x="${cx[3]}" y="100" text-anchor="middle" font-size="10.5" font-weight="700" letter-spacing="0.5" fill="${C.label}">BEST DAY</text>

  <text x="${cx[4]}" y="70" text-anchor="middle" font-size="27" font-weight="700" fill="${C.num}">${stats.activeDays}</text>
  <text x="${cx[4]}" y="100" text-anchor="middle" font-size="10.5" font-weight="700" letter-spacing="0.5" fill="${C.label}">ACTIVE DAYS</text>

  <text x="${cx[5]}" y="70" text-anchor="middle" font-size="27" font-weight="700" fill="${C.num}">${stats.avgPerDay}</text>
  <text x="${cx[5]}" y="100" text-anchor="middle" font-size="10.5" font-weight="700" letter-spacing="0.5" fill="${C.label}">AVG / DAY</text>
</svg>`;

// 시간대별 활동 = 브루탈리즘 박스 카드(각진·두꺼운 테두리·하드 그림자·모노 대문자). 바 = 트랙 rect(테두리) + 채움 rect.
const buildProductive = (C) => {
  const barX = 402, barW = 300, barH = 14, row0 = 46, rowH = 38;
  const PH = row0 * 2 + (ptRows.length - 1) * rowH; // 206
  const rows = ptRows.map((r, i) => {
    const cy = row0 + i * rowH;
    const fillW = Math.max(4, (barW * r.percent) / 100).toFixed(1);
    return `
  <rect x="30" y="${cy - 6}" width="12" height="12" fill="${C.ink}"/>
  <text x="54" y="${cy + 5}" font-size="14" font-weight="700" letter-spacing="0.5" fill="${C.num}">${r.label.toUpperCase()}</text>
  <text x="170" y="${cy + 5}" font-size="12" fill="${C.date}">${r.time}</text>
  <text x="380" y="${cy + 5}" text-anchor="end" font-size="12" fill="${C.num}">${r.n} COMMITS</text>
  <rect x="${barX}" y="${cy - barH / 2}" width="${barW}" height="${barH}" fill="${C.track}" stroke="${C.border}" stroke-width="1.5"/>
  <rect x="${barX}" y="${cy - barH / 2}" width="${fillW}" height="${barH}" fill="${C.accent}"/>
  <text x="806" y="${cy + 5}" text-anchor="end" font-size="14" font-weight="700" fill="${C.accent}">${r.percent.toFixed(1)}%</text>`;
  }).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W + SHX}" height="${PH + SHY}" viewBox="0 0 ${W + SHX} ${PH + SHY}" font-family="${MONO}">
  <rect x="${1.5 + SHX}" y="${1.5 + SHY}" width="843" height="${PH - 3}" fill="${C.shadow}"/>
  <rect x="1.5" y="1.5" width="843" height="${PH - 3}" fill="${C.bg}" stroke="${C.border}" stroke-width="3"/>${rows}
</svg>`;
};

// ============ 정적 브루탈리즘 요소: 섹션 제목 스트립 + Tech Stack 박스 ============
// 제목을 <h3> 대신 SVG 이미지로 만들어 GitHub 자동 앵커 링크(제목 앞 🔗)를 제거.
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const cw = (s, fs) => s.length * fs * 0.6; // 모노 글자폭 근사

const buildTitle = (text, C) => `<svg xmlns="http://www.w3.org/2000/svg" width="854" height="46" viewBox="0 0 854 46" font-family="${MONO}">
  <text x="3" y="29" font-size="20" font-weight="700" letter-spacing="1" fill="${C.ink}">${esc(text)}</text>
  <rect x="3" y="37" width="840" height="4" fill="${C.ink}"/>
</svg>`;

const techStack = [
  { cat: "Language",          items: ["Delphi", "Java", "Kotlin", "JavaScript", "Python", "Dart"] },
  { cat: "Backend",           items: [".NET", "ASP.NET", "JSP", "Spring Boot", "Node.js"] },
  { cat: "Frontend & Mobile", items: ["Angular", "React", "Next.js", "Flutter", "Android"] },
  { cat: "Data & Domain",     items: ["PostgreSQL", "Oracle", "MySQL", "OCPP 1.6"] },
  { cat: "AI Engineering",    items: ["Claude Code", "Spec-Driven Development"] },
  { cat: "Infra & Delivery",  items: ["Vercel", "Supabase", "Git Worktree", "Vite"] },
];
const buildTechStack = (C) => {
  const catW = 170, padTop = 14, rowH = 36, chipFS = 12.5, chipH = 22, chipPadX = 9, chipGap = 7;
  const IH = padTop * 2 + techStack.length * rowH; // 244
  const chipsX = catW + 16;
  const body = techStack.map((r, i) => {
    const cy = padTop + rowH / 2 + i * rowH;
    let x = chipsX;
    const chips = r.items.map((t) => {
      const w = cw(t, chipFS) + chipPadX * 2;
      const g = `
  <rect x="${x.toFixed(1)}" y="${(cy - chipH / 2).toFixed(1)}" width="${w.toFixed(1)}" height="${chipH}" fill="${C.ink}"/>
  <text x="${(x + w / 2).toFixed(1)}" y="${(cy + 4).toFixed(1)}" text-anchor="middle" font-size="${chipFS}" font-weight="700" fill="${C.bg}">${esc(t)}</text>`;
      x += w + chipGap;
      return g;
    }).join("");
    const div = i > 0 ? `\n  <line x1="8" y1="${padTop + i * rowH}" x2="838" y2="${padTop + i * rowH}" stroke="${C.border}" stroke-width="1.5"/>` : "";
    return `${div}
  <text x="22" y="${(cy + 4).toFixed(1)}" font-size="12.5" font-weight="700" letter-spacing="0.5" fill="${C.num}">${esc(r.cat.toUpperCase())}</text>${chips}`;
  }).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W + SHX}" height="${IH + SHY}" viewBox="0 0 ${W + SHX} ${IH + SHY}" font-family="${MONO}">
  <rect x="${1.5 + SHX}" y="${1.5 + SHY}" width="843" height="${IH - 3}" fill="${C.shadow}"/>
  <rect x="1.5" y="1.5" width="843" height="${IH - 3}" fill="${C.bg}" stroke="${C.border}" stroke-width="3"/>
  <line x1="${catW}" y1="8" x2="${catW}" y2="${IH - 8}" stroke="${C.border}" stroke-width="2"/>${body}
</svg>`;
};
const products = [
  { date: "2026", name: "Vibe101",      desc: 'Learn-by-building "vibe coding" platform (KO/EN)' },
  { date: "2026", name: "Ondol",        desc: "Rent/Jeonse verification & scam-risk check for foreigners in Korea" },
  { date: "2025", name: "BriefAuction", desc: "Nationwide court real-estate auction data — search, monthly stats & guides" },
];
const buildProducts = (C) => {
  const dateX = 40, projX = 96, descX = 266, d1 = 80, d2 = 250, padTop = 14, rowH = 36;
  const IH = padTop * 2 + (products.length + 1) * rowH; // header + rows = 172
  const rowY = (i) => padTop + rowH / 2 + i * rowH + 4;
  let out = `
  <text x="${dateX}" y="${rowY(0)}" text-anchor="middle" font-size="12" font-weight="700" letter-spacing="0.5" fill="${C.num}">DATE</text>
  <text x="${projX}" y="${rowY(0)}" font-size="12" font-weight="700" letter-spacing="0.5" fill="${C.num}">PROJECT</text>
  <text x="${descX}" y="${rowY(0)}" font-size="12" font-weight="700" letter-spacing="0.5" fill="${C.num}">DESCRIPTION</text>`;
  products.forEach((p, idx) => {
    const i = idx + 1;
    out += `
  <line x1="8" y1="${padTop + i * rowH}" x2="838" y2="${padTop + i * rowH}" stroke="${C.border}" stroke-width="1.5"/>
  <text x="${dateX}" y="${rowY(i)}" text-anchor="middle" font-size="13" fill="${C.num}">${esc(p.date)}</text>
  <text x="${projX}" y="${rowY(i)}" font-size="13" font-weight="700" fill="${C.num}">${esc(p.name)}</text>
  <text x="${descX}" y="${rowY(i)}" font-size="12" fill="${C.num}">${esc(p.desc)}</text>`;
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W + SHX}" height="${IH + SHY}" viewBox="0 0 ${W + SHX} ${IH + SHY}" font-family="${MONO}">
  <rect x="${1.5 + SHX}" y="${1.5 + SHY}" width="843" height="${IH - 3}" fill="${C.shadow}"/>
  <rect x="1.5" y="1.5" width="843" height="${IH - 3}" fill="${C.bg}" stroke="${C.border}" stroke-width="3"/>
  <line x1="${d1}" y1="8" x2="${d1}" y2="${IH - 8}" stroke="${C.border}" stroke-width="2"/>
  <line x1="${d2}" y1="8" x2="${d2}" y2="${IH - 8}" stroke="${C.border}" stroke-width="2"/>${out}
</svg>`;
};
const TITLES = [
  ["title-techstack", "TECH STACK"],
  ["title-products", "PRODUCTS"],
  ["title-active", "WHEN AM I MOST ACTIVE"],
  ["title-streak", "COMMIT STREAK"],
];

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
writeFileSync("output/techstack-dark.svg", buildTechStack(themes.dark));
writeFileSync("output/techstack-light.svg", buildTechStack(themes.light));
writeFileSync("output/products-dark.svg", buildProducts(themes.dark));
writeFileSync("output/products-light.svg", buildProducts(themes.light));
for (const [name, text] of TITLES) {
  writeFileSync(`output/${name}-dark.svg`, buildTitle(text, themes.dark));
  writeFileSync(`output/${name}-light.svg`, buildTitle(text, themes.light));
}
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
