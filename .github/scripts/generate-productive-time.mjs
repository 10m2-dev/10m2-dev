// .github/scripts/generate-productive-time.mjs
// 커밋 시각을 Morning/Daytime/Evening/Night 4구간으로 집계해
// README.md 의 마커(<!-- PRODUCTIVE-TIME:START/END -->) 사이에 텍스트 코드블록으로 써넣는다.
// 제목은 README의 <h3>가 담당한다.
// - GH_TOKEN: repo 스코프 PAT (private 레포 커밋을 직접 읽기 위함)
// - TIMEZONE: 예) Asia/Seoul
// CI(GITHUB_ACTIONS)에서는 이 스크립트가 직접 README.md를 커밋/푸시한다.
import { readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";

const TOKEN = process.env.GH_TOKEN;
const TZ = process.env.TIMEZONE || "Asia/Seoul";
const README = "README.md";
const START = "<!-- PRODUCTIVE-TIME:START -->";
const END = "<!-- PRODUCTIVE-TIME:END -->";
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

// 단일 코드포인트 이모지(변형 선택자 없음) → 폭 일정 → 정렬됨
const rows = [
  { emoji: "🌅", label: "Morning", time: "06-12", n: buckets.morning },
  { emoji: "🌞", label: "Daytime", time: "12-18", n: buckets.daytime },
  { emoji: "🌆", label: "Evening", time: "18-24", n: buckets.evening },
  { emoji: "🌙", label: "Night",   time: "00-06", n: buckets.night },
].map((r) => ({ ...r, percent: (r.n / total) * 100 }));

// 막대: 폭이 일정한 █ 하나로만(빈 칸은 공백) → Windows에서도 안 깨지고 정렬됨
function makeBar(percent, size = 30) {
  const full = Math.round((percent / 100) * size);
  return "█".repeat(full) + " ".repeat(Math.max(0, size - full));
}

const lines = rows
  .map((r, i) => {
    const n = String(r.n).padStart(3);
    const label = r.label.padEnd(7);
    const pct = r.percent.toFixed(1).padStart(4);
    return `${i + 1}    ${r.emoji}   ${label}    ${r.time}     ${n} commits     ${makeBar(r.percent)}     ${pct}%`;
  })
  .join("\n");

const block = `${START}\n\n\`\`\`text\n${lines}\n\`\`\`\n\n${END}`;

let readme = readFileSync(README, "utf8");
const re = new RegExp(`${START}[\\s\\S]*?${END}`);
if (!re.test(readme)) {
  console.error("markers not found in README.md");
  process.exit(1);
}
readme = readme.replace(re, block);
writeFileSync(README, readme);
console.log("README updated", buckets, "total:", total);

// CI: 직접 커밋/푸시 (워크플로 파일은 건드리지 않음)
if (process.env.GITHUB_ACTIONS) {
  execSync('git config user.name "github-actions[bot]"');
  execSync('git config user.email "41898282+github-actions[bot]@users.noreply.github.com"');
  execSync(`git add ${README}`);
  try {
    execSync('git commit -m "chore: update productive-time"', { stdio: "inherit" });
    execSync("git push", { stdio: "inherit" });
  } catch {
    console.log("nothing to commit");
  }
}
