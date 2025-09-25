import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

// 환경변수에서 GitLab 설정 로드
function withScheme(url: string): string {
    return /^https?:\/\//i.test(url) ? url : `https://${url}`;
}

function stripTrailingSlash(url: string): string {
    return url.replace(/\/+$/g, '');
}

const RAW_GITLAB_URL = process.env.GITLAB_URL || '';
const RAW_GITLAB_API_BASE = process.env.GITLAB_API_BASE || '';
const GITLAB_API_BASE = RAW_GITLAB_API_BASE
    ? stripTrailingSlash(RAW_GITLAB_API_BASE)
    : RAW_GITLAB_URL
    ? `${stripTrailingSlash(withScheme(RAW_GITLAB_URL))}/api/v4`
    : 'https://183.99.50.117/api/v4';

const GITLAB_TOKEN = process.env.GITLAB_TOKEN || '';

// 자체서명 인증서 우회 (개발용): INSECURE_TLS=true 일 때만 활성화
if ((process.env.INSECURE_TLS || '').toLowerCase() === 'true') {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
}

let lastGitLabError: string | null = null;

// Helper function for making GitLab API requests
async function makeGitLabRequest<T>(endpoint: string): Promise<T | null> {
    const url = `${GITLAB_API_BASE}${endpoint}`;
    const headers = {
        'Private-Token': GITLAB_TOKEN,
        'Content-Type': 'application/json',
    };

    try {
        lastGitLabError = null;
        if (!GITLAB_TOKEN) {
            lastGitLabError = 'GITLAB_TOKEN is not set';
            return null;
        }
        // Node 18+ fetch 사용. 자체서명 인증서 우회는 전역 NODE_TLS_REJECT_UNAUTHORIZED=0로 처리됨
        const response = await fetch(url, { headers });
        if (!response.ok) {
            let bodySnippet = '';
            try {
                const txt = await response.text();
                bodySnippet = (txt || '').slice(0, 500);
            } catch {}
            lastGitLabError = `HTTP ${response.status} ${response.statusText} | URL: ${url} | Body: ${bodySnippet}`;
            return null;
        }
        return (await response.json()) as T;
    } catch (error) {
        const anyErr = error as any;
        const code = anyErr?.code || anyErr?.cause?.code || '';
        const errMsg = anyErr?.message || String(anyErr);
        lastGitLabError = `Fetch failed${code ? ` [${code}]` : ''}: ${errMsg} | URL: ${url}`;
        console.error('Error making GitLab request:', error);
        return null;
    }
}

interface GitLabUser {
    id: number;
    username: string;
    name: string;
}

interface GitLabProject {
    id: number;
    name: string;
    path_with_namespace: string;
    web_url: string;
}

interface GitLabMergeRequest {
    id: number;
    iid: number;
    title: string;
    description: string;
    state: string;
    created_at: string;
    updated_at: string;
    web_url: string;
    source_branch: string;
    target_branch: string;
    author: GitLabUser;
    assignee: GitLabUser | null;
    assignees: GitLabUser[];
    project?: GitLabProject;
    project_id?: number;
    references?: {
        full?: string;
    };
}

interface GitLabChange {
    old_path: string;
    new_path: string;
    a_mode?: string;
    b_mode?: string;
    new_file?: boolean;
    renamed_file?: boolean;
    deleted_file?: boolean;
    diff: string;
}

interface GitLabMergeRequestWithChanges extends GitLabMergeRequest {
    changes?: GitLabChange[];
}

function extractProjectPathFromUrl(webUrl: string | undefined): string | null {
    if (!webUrl) return null;
    try {
        const u = new URL(webUrl);
        const p = u.pathname; // "/group/project/-/merge_requests/123"
        const marker = '/-/merge_requests';
        const idx = p.indexOf(marker);
        if (idx > 1) {
            return p.slice(1, idx); // remove leading '/'
        }
        const parts = p.split('/').filter(Boolean);
        if (parts.length >= 2) return `${parts[0]}/${parts[1]}`;
        return null;
    } catch {
        return null;
    }
}

// Format merge request data
function formatMergeRequest(mr: GitLabMergeRequest): string {
    const assignees = mr.assignees?.map((a) => a.name).join(', ') || 'None';
    const projectPath =
        mr.project?.path_with_namespace ||
        (mr.references?.full ? mr.references.full.split('!')[0] : undefined) ||
        extractProjectPathFromUrl(mr.web_url) ||
        (mr.project_id !== undefined ? `project_id:${mr.project_id}` : 'Unknown');
    return [
        `제목: ${mr.title}`,
        `프로젝트: ${projectPath}`,
        `상태: ${mr.state}`,
        `작성자: ${mr.author.name} (@${mr.author.username})`,
        `담당자: ${assignees}`,
        `소스 브랜치: ${mr.source_branch} → ${mr.target_branch}`,
        `생성일: ${new Date(mr.created_at).toLocaleString('ko-KR')}`,
        `수정일: ${new Date(mr.updated_at).toLocaleString('ko-KR')}`,
        `URL: ${mr.web_url}`,
        '---',
    ].join('\n');
}

async function resolveProjectId(projectIdentifier: string): Promise<number | null> {
    // 숫자면 그대로 프로젝트 ID로 사용
    if (/^\d+$/.test(projectIdentifier)) {
        return Number(projectIdentifier);
    }
    // path_with_namespace로 조회
    const encoded = encodeURIComponent(projectIdentifier);
    const proj = await makeGitLabRequest<GitLabProject>(`/projects/${encoded}`);
    return proj?.id ?? null;
}

// Create server instance
const server = new McpServer({
    name: 'gitlab',
    version: '1.0.0',
});

// Register GitLab tools
server.tool(
    'get-assigned-merge-requests',
    '현재 내 계정에 할당된 Merge Request 목록을 조회합니다',
    {
        state: z
            .enum(['opened', 'closed', 'merged', 'all'])
            .optional()
            .default('opened')
            .describe('MR 상태 (opened, closed, merged, all)'),
    },
    async ({ state = 'opened' }) => {
        // 먼저 현재 사용자 정보를 가져옴
        const currentUser = await makeGitLabRequest<GitLabUser>('/user');
        if (!currentUser) {
            return {
                content: [
                    {
                        type: 'text',
                        text: `GitLab API 인증에 실패했습니다. 토큰/네트워크/TLS 설정을 확인해주세요.\n세부: ${
                            lastGitLabError || '원인 미상'
                        }`,
                    },
                ],
            };
        }

        // 현재 사용자에게 할당된 MR 조회
        const endpoint = `/merge_requests?assignee_id=${currentUser.id}&state=${state}&scope=all`;
        const mergeRequests = await makeGitLabRequest<GitLabMergeRequest[]>(endpoint);

        if (!mergeRequests) {
            return {
                content: [
                    {
                        type: 'text',
                        text: `Merge Request 데이터를 가져오는데 실패했습니다.\n세부: ${
                            lastGitLabError || '원인 미상'
                        }`,
                    },
                ],
            };
        }

        if (mergeRequests.length === 0) {
            return {
                content: [
                    {
                        type: 'text',
                        text: `${currentUser.name} (@${currentUser.username})님에게 할당된 ${state} 상태의 Merge Request가 없습니다.`,
                    },
                ],
            };
        }

        const formattedMRs = mergeRequests.map(formatMergeRequest);
        const mrText = `${currentUser.name} (@${
            currentUser.username
        })님에게 할당된 Merge Request (${state}):\n\n${formattedMRs.join('\n')}`;

        return {
            content: [
                {
                    type: 'text',
                    text: mrText,
                },
            ],
        };
    },
);

// MR 코드리뷰 생성 도구
// (제거됨) review-merge-request 도구: 클라이언트 AI가 리뷰를 수행하므로 서버 내 리뷰 기능 제거

// MR 변경점(raw changes)만 반환하는 도구
server.tool(
    'get-merge-request-changes',
    '특정 프로젝트의 특정 MR(iid/!번호)의 변경 파일과 diff만 반환합니다',
    {
        project: z
            .string()
            .describe(
                '프로젝트 식별자. 숫자(Project ID) 또는 path_with_namespace (예: group/subgroup/project)',
            ),
        mr: z.string().describe('MR IID 또는 !번호 (예: 123 혹은 !123)'),
    },
    async ({ project, mr }) => {
        const projectId = await resolveProjectId(project);
        if (!projectId) {
            return {
                content: [
                    {
                        type: 'text',
                        text: `프로젝트를 찾을 수 없습니다: ${project}.\n세부: ${
                            lastGitLabError || '원인 미상'
                        }`,
                    },
                ],
            };
        }

        const iid = String(mr).startsWith('!') ? String(mr).slice(1) : String(mr);
        const mrChanges = await makeGitLabRequest<{ changes: GitLabChange[] }>(
            `/projects/${projectId}/merge_requests/${iid}/changes`,
        );
        if (!mrChanges || !mrChanges.changes) {
            return {
                content: [
                    {
                        type: 'text',
                        text: `변경 내역(changes)을 가져오지 못했습니다.\n세부: ${
                            lastGitLabError || '원인 미상'
                        }`,
                    },
                ],
            };
        }

        // 클라이언트 AI가 직접 리뷰할 수 있도록 최소 가공 데이터 반환
        const payload = mrChanges.changes.map((c) => ({
            old_path: c.old_path,
            new_path: c.new_path,
            new_file: !!c.new_file,
            renamed_file: !!c.renamed_file,
            deleted_file: !!c.deleted_file,
            diff: c.diff,
        }));

        return {
            content: [
                {
                    type: 'text',
                    text: JSON.stringify(
                        {
                            project: project,
                            project_id: projectId,
                            mr: `!${iid}`,
                            changes: payload,
                        },
                        null,
                        2,
                    ),
                },
            ],
        };
    },
);

// Start the server
async function main() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error('GitLab MCP Server running on stdio');
}

main().catch((error) => {
    console.error('Fatal error in main():', error);
    process.exit(1);
});
