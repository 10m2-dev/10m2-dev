// .github/scripts/generate-productive-time.mjs
// README.md 의 마커 사이에 (1) 시간별 커밋 카드, (2) Streak 카드를 텍스트로 써넣는다.
// 제목은 README의 <h3>가 담당. private 반영은 "Include private contributions" 설정 + repo 스코프 PAT.
// - GH_TOKEN: repo 스코프 PAT
// - TIMEZONE: 예) Asia/Seoul
// CI(GITHUB_ACTIONS)에서는 이 스크립트가 직접 README.md를 커밋/푸시한다.
import { readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";

const TOKEN = process.env.GH_TOKEN;
const TZ = process.env.TIMEZONE || "Asia/Seoul";
const README = "README.md";
const PT_START = "<!-- PRODUCTIVE-TIME:START -->";
const PT_END = "<!-- PRODUCTIVE-TIME:END -->";
const S_START = "<!-- STREAK:START -->";
const S_END = "<!-- STREAK:END -->";
if (!TOKEN) {
  console.error("GH_TOKEN is required");
  process.exit(1);
}

async function gql(query, variables = {}) {
  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      Authorization: `bearer ${TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (json.errors) throw new Error(JSON.stringify(json.errors));
  return json.data;
}

const { viewer } = await gql(`query { viewer { id login } }`);

// ============ (1) 시간별 커밋 ============
const buckets = { morning: 0, daytime: 0, evening: 0, night: 0 };
const hourFmt = new Intl.DateTimeFormat("en-GB", {
  timeZone: TZ,
  hour: "2-digit",
  hourCycle: "h23",
});
const bucketOf = (h) =>
  h >= 6 && h < 12 ? "morning"
  : h >= 12 && h < 18 ? "daytime"
  : h >= 18 && h < 24 ? "evening"
  : "night";

let after = null;
let pages = 0;
do {
  const data = await gql(
    `query($after: String, $id: ID!) {
      viewer {
        repositories(first: 50, after: $after, isFork: false,
                     ownerAffiliations: [OWNER],
                     orderBy: {field: PUSHED_AT, direction: DESC}) {
          nodes {
            defaultBranchRef {
              target {
                ... on Commit {
                  history(first: 100, author: {id: $id}) {
                    nodes { committedDate }
                  }
                }
              }
            }
          }
          pageInfo { hasNextPage endCursor }
        }
      }
    }`,
    { after, id: viewer.id }
  );
  const repos = data.viewer.repositories;
  for (const repo of repos.nodes) {
    const history = repo.defaultBranchRef?.target?.history?.nodes ?? [];
    for (const c of history) {
      buckets[bucketOf(Number(hourFmt.format(new Date(c.committedDate))))]++;
    }
  }
  after = repos.pageInfo.hasNextPage ? repos.pageInfo.endCursor : null;
} while (after && ++pages < 4);

const total = Object.values(buckets).reduce((a, b) => a + b, 0) || 1;
const ptRows = [
  { emoji: "🌅", label: "Morning", time: "06-12", n: buckets.morning },
  { emoji: "🌞", label: "Daytime", time: "12-18", n: buckets.daytime },
  { emoji: "🌆", label: "Evening", time: "18-24", n: buckets.evening },
  { emoji: "🌙", label: "Night",   time: "00-06", n: buckets.night },
].map((r) => ({ ...r, percent: (r.n / total) * 100 }));

// 막대: █ 하나로만(맨 끝, 패딩 없음) → Windows에서도 안 깨짐
const makeBar = (percent, size = 25) => "█".repeat(Math.round((percent / 100) * size));

const ptLines = ptRows
  .map((r, i) => {
    const n = String(r.n).padStart(3);
    const label = r.label.padEnd(7);
    const pct = r.percent.toFixed(1).padStart(4);
    return `${i + 1}    ${r.emoji}   ${label}    ${r.time}     ${n} commits     ${pct}%   ${makeBar(r.percent)}`;
  })
  .join("\n");
const ptBlock = `${PT_START}\n\n\`\`\`text\n${ptLines}\n\`\`\`\n\n${PT_END}`;

// ============ (2) Streak ============
const cal = await gql(`query {
  viewer {
    contributionsCollection {
      contributionCalendar {
        totalContributions
        weeks { contributionDays { date contributionCount } }
      }
    }
  }
}`);
const calObj = cal.viewer.contributionsCollection.contributionCalendar;
const days = calObj.weeks.flatMap((w) => w.contributionDays); // 날짜 오름차순
const totalContrib = calObj.totalContributions;

let longest = 0;
let run = 0;
for (const d of days) {
  if (d.contributionCount > 0) {
    run++;
    if (run > longest) longest = run;
  } else {
    run = 0;
  }
}
let current = 0;
for (let i = days.length - 1; i >= 0; i--) {
  if (days[i].contributionCount > 0) current++;
  else if (i === days.length - 1) continue; // 오늘은 아직 0이어도 어제까지의 연속 유지
  else break;
}

const sRows = [
  { label: "Current Streak", val: `${current} days` },
  { label: "Longest Streak", val: `${longest} days` },
  { label: "Contributions", val: `${totalContrib} total` },
];
const sLines = sRows.map((x) => `${x.label.padEnd(15)}${x.val}`).join("\n");
const sBlock = `${S_START}\n\n\`\`\`text\n${sLines}\n\`\`\`\n\n${S_END}`;

// ============ 주입 ============
let readme = readFileSync(README, "utf8");
const inject = (text, start, end, block) => {
  const re = new RegExp(`${start}[\\s\\S]*?${end}`);
  if (!re.test(text)) {
    console.error(`markers not found: ${start}`);
    process.exit(1);
  }
  return text.replace(re, block);
};
readme = inject(readme, PT_START, PT_END, ptBlock);
readme = inject(readme, S_START, S_END, sBlock);
writeFileSync(README, readme);
console.log("README updated", { buckets, total, current, longest, totalContrib });

// CI: 직접 커밋/푸시 (워크플로 파일은 건드리지 않음)
if (process.env.GITHUB_ACTIONS) {
  execSync('git config user.name "github-actions[bot]"');
  execSync('git config user.email "41898282+github-actions[bot]@users.noreply.github.com"');
  execSync(`git add ${README}`);
  try {
    execSync('git commit -m "chore: update profile cards"', { stdio: "inherit" });
    execSync("git push", { stdio: "inherit" });
  } catch {
    console.log("nothing to commit");
  }
}
