import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AiSearchQuery } from './entities/ai-search-query.entity';
import { User } from '../users/entities/user.entity';

@Injectable()
export class RagService {
    private readonly logger = new Logger(RagService.name);
    private readonly aiServiceBaseUrl: string;
    private readonly ragOutOfScopeMessage =
        'Sorry, I can only answer questions based on our employee RAG data (employees, skills, certifications, projects, and experience).';
    private readonly ragNoDataMessage =
        "Sorry, I couldn't find that information in our employee RAG data.";

    constructor(
        private readonly configService: ConfigService,
        @InjectRepository(AiSearchQuery)
        private readonly searchQueryRepo: Repository<AiSearchQuery>,
    ) {
        this.aiServiceBaseUrl =
            this.configService.get<string>('AI_SERVICE_URL')?.replace(/\/+$/, '') ||
            'http://127.0.0.1:8000';
    }

    /**
     * Trigger a RAG sync for a specific user.
     * This calls the AI service's /api/v1/rag/sync/{userId} endpoint.
     */
    async triggerUserSync(userId: string): Promise<void> {
        try {
            const url = `${this.aiServiceBaseUrl}/api/v1/rag/sync/${userId}`;
            this.logger.log(`Triggering RAG sync for user ${userId}...`);

            const response = await fetch(url, {
                method: 'POST',
            });

            if (!response.ok) {
                this.logger.error(`Failed to trigger RAG sync for user ${userId}: ${response.statusText}`);
            } else {
                this.logger.log(`RAG sync triggered successfully for user ${userId}`);
            }
        } catch (error) {
            this.logger.error(`Error triggering RAG sync for user ${userId}: ${error.message}`);
        }
    }

    /**
     * Trigger a full RAG sync for all users.
     */
    async triggerFullSync(): Promise<void> {
        try {
            const url = `${this.aiServiceBaseUrl}/api/v1/rag/sync-all`;
            this.logger.log('Triggering full RAG sync...');

            const response = await fetch(url, {
                method: 'POST',
            });

            if (!response.ok) {
                this.logger.error(`Failed to trigger full RAG sync: ${response.statusText}`);
            } else {
                this.logger.log('Full RAG sync triggered successfully');
            }
        } catch (error) {
            this.logger.error(`Error triggering full RAG sync: ${error.message}`);
        }
    }

    /**
     * Send a query to the AI RAG system.
     */
    async chat(message: string, sessionId: string, userId?: string) {
        const startedAt = Date.now();
        try {
            const url = `${this.aiServiceBaseUrl}/api/v1/rag/chat`;
            const response = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ message, session_id: sessionId }),
            });

            if (!response.ok) {
                let body = '';
                try {
                    body = await response.text();
                } catch {
                    body = '';
                }
                const snippet = body ? body.slice(0, 500) : 'no body';
                this.logger.error(`AI Chat failed: ${response.status} ${response.statusText} | ${snippet}`);
                throw new Error('AI Service connection error');
            }

            const payload = await response.json();
            const elapsedMs = Date.now() - startedAt;
            const context = Array.isArray(payload?.context) ? payload.context : [];
            const results = this.buildResults(context, message);
            const groundedAnswer = this.buildGroundedAnswer(message, context, results, payload?.answer);
            const extractedEntities = this.extractEntities(context);
            const resultCount = this.resolveResultCount(context, extractedEntities, results);
            await this.safeLogQuery(userId, message, extractedEntities, resultCount, elapsedMs);
            return { ...payload, answer: groundedAnswer, results };
        } catch (error) {
            this.logger.error(`Error in RAG chat: ${error.message}`);
            const elapsedMs = Date.now() - startedAt;
            await this.safeLogQuery(userId, message, null, 0, elapsedMs);
            throw error;
        }
    }

    /**
     * Stream a RAG chat response. Proxies the AI service NDJSON stream,
     * intercepts the context event to build result cards, and forwards
     * everything to the caller as NDJSON lines.
     */
    async *chatStream(
        message: string,
        sessionId: string,
        userId?: string,
    ): AsyncGenerator<string> {
        const startedAt = Date.now();
        let fullAnswer = '';
        let contextArr: any[] = [];

        try {
            const url = `${this.aiServiceBaseUrl}/api/v1/rag/chat/stream`;
            const response = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ message, session_id: sessionId }),
            });

            if (!response.ok) {
                throw new Error(`AI stream failed: ${response.status}`);
            }

            const reader = response.body?.getReader();
            if (!reader) throw new Error('No readable stream from AI service');

            const decoder = new TextDecoder();
            let buffer = '';

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');
                buffer = lines.pop() || '';

                for (const line of lines) {
                    const trimmed = line.trim();
                    if (!trimmed) continue;

                    try {
                        const event = JSON.parse(trimmed);

                        if (event.type === 'context') {
                            contextArr = Array.isArray(event.data) ? event.data : [];
                            // Build result cards from context and send them first
                            const results = this.buildResults(contextArr, message);
                            yield JSON.stringify({ type: 'results', data: results }) + '\n';
                        } else if (event.type === 'token') {
                            fullAnswer += event.data || '';
                            yield trimmed + '\n';
                        } else if (event.type === 'replace') {
                            fullAnswer = event.data || '';
                            yield trimmed + '\n';
                        } else if (event.type === 'done') {
                            yield trimmed + '\n';
                        }
                    } catch {
                        // Skip malformed lines
                    }
                }
            }
        } catch (error) {
            this.logger.error(`Stream error: ${error.message}`);
            yield JSON.stringify({ type: 'token', data: 'Sorry, I could not reach the AI service.' }) + '\n';
            yield JSON.stringify({ type: 'done' }) + '\n';
            fullAnswer = 'Sorry, I could not reach the AI service.';
        }

        // Log the query after the stream completes
        const elapsedMs = Date.now() - startedAt;
        const extractedEntities = this.extractEntities(contextArr);
        const resultCount = this.resolveResultCount(contextArr, extractedEntities, []);
        await this.safeLogQuery(userId, message, extractedEntities, resultCount, elapsedMs);
    }

    /**
     * Delete RAG vectors for a specific user (best-effort).
     */
    async deleteUserVectors(userId: string): Promise<void> {
        try {
            const url = `${this.aiServiceBaseUrl}/api/v1/rag/vectors/${userId}`;
            const response = await fetch(url, { method: 'DELETE' });
            if (!response.ok) {
                this.logger.error(`Failed to delete RAG vectors for user ${userId}: ${response.statusText}`);
            } else {
                this.logger.log(`RAG vectors deletion queued for user ${userId}`);
            }
        } catch (error) {
            this.logger.error(`Error deleting RAG vectors for user ${userId}: ${error.message}`);
        }
    }

    private resolveResultCount(
        context: any[],
        entities?: Record<string, any> | null,
        results?: Array<{ name: string }>,
    ): number {
        if (Array.isArray(results) && results.length) return results.length;
        if (entities?.employees?.length) return entities.employees.length;
        return Array.isArray(context) ? context.length : 0;
    }

    private extractEntities(context: any[]): Record<string, any> | null {
        if (!Array.isArray(context)) return null;

        const employees = new Set<string>();
        const certifications = new Set<string>();
        const projects = new Set<string>();
        const companies = new Set<string>();

        for (const item of context) {
            const metadata = item?.metadata || {};
            const name = typeof metadata.name === 'string' ? metadata.name.trim() : '';
            if (name) employees.add(name);

            const directoryEmployees = Array.isArray(metadata.employees) ? metadata.employees : [];
            for (const emp of directoryEmployees) {
                const empName = typeof emp?.name === 'string' ? emp.name.trim() : '';
                if (empName) employees.add(empName);
                if (Array.isArray(emp?.companies)) {
                    emp.companies.forEach((company: any) => {
                        const value = typeof company === 'string' ? company.trim() : '';
                        if (value) companies.add(value);
                    });
                }
            }

            const certificationName = typeof metadata.certification_name === 'string'
                ? metadata.certification_name.trim()
                : '';
            if (certificationName) certifications.add(certificationName);

            const certList = Array.isArray(metadata.certifications) ? metadata.certifications : [];
            certList.forEach((cert: any) => {
                const value = typeof cert === 'string' ? cert.trim() : '';
                if (value) certifications.add(value);
            });

            const projectName = typeof metadata.project_name === 'string'
                ? metadata.project_name.trim()
                : '';
            if (projectName) projects.add(projectName);

            const companyName = typeof metadata.company_name === 'string'
                ? metadata.company_name.trim()
                : typeof metadata.client_name === 'string'
                    ? metadata.client_name.trim()
                    : '';
            if (companyName) companies.add(companyName);
        }

        const entities: Record<string, any> = {};
        if (employees.size) entities.employees = Array.from(employees);
        if (certifications.size) entities.certifications = Array.from(certifications);
        if (projects.size) entities.projects = Array.from(projects);
        if (companies.size) entities.companies = Array.from(companies);

        return Object.keys(entities).length ? entities : null;
    }

    private buildResults(context: any[], query?: string): Array<{
        name: string;
        role?: string;
        experienceYears?: number;
        companies?: string[];
        certifications?: string[];
        projects?: string[];
        skills?: string[];
    }> {
        if (!Array.isArray(context)) return [];

        const queryTokens = this.extractQueryTokens(query);
        // Generic fallback policy: if the query is broad/underspecified, allow directory rows as a backup.
        const allowDirectoryFallback = queryTokens.length <= 1;
        const minYears = this.extractMinExperienceYears(query);
        const directoryIndex = new Map<string, { role?: string; experienceYears?: number; companies: Set<string> }>();

        type Draft = {
            name: string;
            role?: string;
            experienceYears?: number;
            companies: Set<string>;
            certifications: Set<string>;
            projects: Set<string>;
            skills: Set<string>;
            sourceTypes: Set<string>;
            tokenMatch: boolean;
        };

        const results = new Map<string, Draft>();
        const directoryFallback: Draft[] = [];

        const ensure = (name: string) => {
            const key = name.trim();
            if (!key) return null;
            let draft = results.get(key);
            if (!draft) {
                draft = {
                    name: key,
                    companies: new Set<string>(),
                    certifications: new Set<string>(),
                    projects: new Set<string>(),
                    skills: new Set<string>(),
                    sourceTypes: new Set<string>(),
                    tokenMatch: false,
                };
                results.set(key, draft);
            }
            return draft;
        };

        const addSetValues = (set: Set<string>, values: any) => {
            if (!values) return;
            if (Array.isArray(values)) {
                values.forEach((value) => {
                    const cleaned = typeof value === 'string' ? value.trim() : '';
                    if (cleaned) set.add(cleaned);
                });
                return;
            }
            const cleaned = typeof values === 'string' ? values.trim() : '';
            if (cleaned) set.add(cleaned);
        };

        for (const item of context) {
            const meta = item?.metadata || {};
            const chunkType = String(meta.chunk_type || '').toLowerCase();
            const rawContent = typeof item?.content === 'string' ? item.content : '';

            if (chunkType === 'directory' && Array.isArray(meta.employees)) {
                for (const emp of meta.employees) {
                    const name = typeof emp?.name === 'string' ? emp.name.trim() : '';
                    if (!name) continue;
                    const existing = directoryIndex.get(name) ?? {
                        role: undefined,
                        experienceYears: undefined,
                        companies: new Set<string>(),
                    };
                    if (!existing.role && typeof emp?.role === 'string' && emp.role.trim()) {
                        existing.role = emp.role.trim();
                    }
                    if (typeof emp?.experience_years === 'number') {
                        existing.experienceYears = emp.experience_years;
                    }
                    addSetValues(existing.companies, emp?.companies);
                    directoryIndex.set(name, existing);
                }

                if (!allowDirectoryFallback) {
                    continue;
                }
                for (const emp of meta.employees) {
                    const name = typeof emp?.name === 'string' ? emp.name.trim() : '';
                    if (!name) continue;
                    const draft = ensure(name);
                    if (!draft) continue;
                    if (!draft.role && typeof emp?.role === 'string' && emp.role.trim()) {
                        draft.role = emp.role.trim();
                    }
                    if (typeof emp?.experience_years === 'number') {
                        draft.experienceYears = emp.experience_years;
                    }
                    addSetValues(draft.companies, emp?.companies);
                    draft.sourceTypes.add('directory');
                }

                if (allowDirectoryFallback) {
                    for (const emp of meta.employees) {
                        const name = typeof emp?.name === 'string' ? emp.name.trim() : '';
                        if (!name) continue;
                        const draft: Draft = {
                            name,
                            role: typeof emp?.role === 'string' ? emp.role.trim() : undefined,
                            experienceYears: typeof emp?.experience_years === 'number' ? emp.experience_years : undefined,
                            companies: new Set<string>(),
                            certifications: new Set<string>(),
                            projects: new Set<string>(),
                            skills: new Set<string>(),
                            sourceTypes: new Set<string>(['directory']),
                            tokenMatch: false,
                        };
                        addSetValues(draft.companies, emp?.companies);
                        directoryFallback.push(draft);
                    }
                }
                continue;
            }

            const name = typeof meta.name === 'string' ? meta.name.trim() : '';
            const draft = ensure(name);
            if (!draft) continue;

            if (chunkType) {
                draft.sourceTypes.add(chunkType);
            }

            if (!draft.role && typeof meta.job_title === 'string' && meta.job_title.trim()) {
                draft.role = meta.job_title.trim();
            }
            if (!draft.role && chunkType === 'profile') {
                const parsedRole = this.parseRoleFromProfile(rawContent, name);
                if (parsedRole) draft.role = parsedRole;
                if (draft.experienceYears == null) {
                    const yearsMatch = rawContent.match(/(\d+)\s+years?\s+of\s+experience/i);
                    if (yearsMatch && yearsMatch[1]) {
                        const years = Number.parseInt(yearsMatch[1], 10);
                        if (Number.isFinite(years)) {
                            draft.experienceYears = years;
                        }
                    }
                }
            }

            if (chunkType === 'skills' && rawContent) {
                rawContent.split('\n').forEach((line) => {
                    const trimmed = line.trim();
                    if (trimmed.startsWith('- ')) {
                        const skill = trimmed.slice(2).trim();
                        if (skill) draft.skills.add(skill);
                    }
                });
            }

            if (typeof meta.company_name === 'string') {
                addSetValues(draft.companies, meta.company_name);
            }
            if (typeof meta.client_name === 'string') {
                addSetValues(draft.companies, meta.client_name);
            }

            if (typeof meta.certification_name === 'string') {
                addSetValues(draft.certifications, meta.certification_name);
            }
            if (Array.isArray(meta.certifications)) {
                addSetValues(draft.certifications, meta.certifications);
            }

            if (typeof meta.project_name === 'string') {
                addSetValues(draft.projects, meta.project_name);
            }

            if (!draft.tokenMatch && queryTokens.length > 0) {
                const evidence = this.buildEvidenceText(rawContent, meta, draft);
                if (this.hasTokenMatch(evidence, queryTokens)) {
                    draft.tokenMatch = true;
                }
            }
        }

        for (const draft of results.values()) {
            const directoryData = directoryIndex.get(draft.name);
            if (!directoryData) continue;
            if (!draft.role && directoryData.role) {
                draft.role = directoryData.role;
            }
            if (draft.experienceYears == null && typeof directoryData.experienceYears === 'number') {
                draft.experienceYears = directoryData.experienceYears;
            }
            addSetValues(draft.companies, Array.from(directoryData.companies));
        }

        let scored = Array.from(results.values()).filter((draft) => {
            return Array.from(draft.sourceTypes).some((type) => type !== 'directory');
        });

        const nameMatches =
            queryTokens.length >= 2
                ? Array.from(results.values()).filter((draft) =>
                    this.nameHasAllTokens(draft.name, queryTokens)
                )
                : [];

        const forcedByName = nameMatches.length > 0;
        if (forcedByName) {
            scored = nameMatches;
        } else if (queryTokens.length > 0) {
            scored = scored.filter((draft) => draft.tokenMatch);
        }

        if (minYears != null) {
            const withYears = scored.filter((draft) => typeof draft.experienceYears === 'number');
            const matches = withYears.filter((draft) => (draft.experienceYears ?? 0) >= minYears);
            if (matches.length > 0) {
                scored = matches;
            }
        }

        const scoredWithRank = scored.map((draft) => {
            const score =
                (draft.role ? 1 : 0) +
                (typeof draft.experienceYears === 'number' ? 1 : 0) +
                (draft.companies.size ? 1 : 0) +
                (draft.certifications.size ? 1 : 0) +
                (draft.projects.size ? 1 : 0) +
                (draft.skills.size ? 1 : 0);
            return { draft, score };
        });

        if (!forcedByName && scoredWithRank.length === 0 && allowDirectoryFallback && directoryFallback.length > 0) {
            return directoryFallback.slice(0, 6).map((draft) => ({
                name: draft.name,
                role: draft.role,
                experienceYears: draft.experienceYears,
                companies: draft.companies.size ? Array.from(draft.companies).slice(0, 3) : undefined,
                certifications: undefined,
                projects: undefined,
                skills: undefined,
            }));
        }

        scoredWithRank.sort((a, b) => b.score - a.score);

        return scoredWithRank.slice(0, 6).map(({ draft }) => ({
            name: draft.name,
            role: draft.role,
            experienceYears: draft.experienceYears,
            companies: draft.companies.size ? Array.from(draft.companies).slice(0, 3) : undefined,
            certifications: draft.certifications.size ? Array.from(draft.certifications).slice(0, 3) : undefined,
            projects: draft.projects.size ? Array.from(draft.projects).slice(0, 3) : undefined,
            skills: draft.skills.size ? Array.from(draft.skills).slice(0, 6) : undefined,
        }));
    }

    private parseRoleFromProfile(content: string, name: string): string | null {
        if (!content) return null;
        const escaped = name.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
        const regex = new RegExp(`${escaped}\\s+is\\s+(?:an|a)\\s+([^\\.\\n]+)`, 'i');
        const match = content.match(regex);
        if (match && match[1]) {
            return match[1].trim();
        }
        return null;
    }

    private nameHasAllTokens(name: string, tokens: string[]): boolean {
        if (!name || tokens.length === 0) return false;
        const normalized = name
            .toLowerCase()
            .replace(/[^a-z0-9\s]/g, ' ')
            .split(/\s+/)
            .filter(Boolean);
        if (!normalized.length) return false;
        return tokens.every((token) => normalized.includes(token));
    }

    private extractQueryTokens(query?: string): string[] {
        if (!query) return [];
        const stopwords = new Set([
            'who', 'has', 'have', 'with', 'the', 'and', 'for', 'a', 'an', 'of', 'to', 'in', 'on', 'at',
            'is', 'are', 'list', 'show', 'find', 'employees', 'employee', 'team', 'members', 'me',
            'please', 'need', 'want', 'looking', 'that', 'those', 'these', 'which', 'whose', 'from',
            'certification', 'certifications', 'skill', 'skills', 'project', 'projects',
            'experience', 'years', 'year', 'yrs', 'yr', 'exp',
            'cert', 'certs', 'certificate', 'certificates', 'certified',
        ]);
        return query
            .toLowerCase()
            .replace(/[^a-z0-9\s]/g, ' ')
            .split(/\s+/)
            .map((token) => token.trim())
            .filter((token) => {
                if (!token) return false;
                if (stopwords.has(token)) return false;
                const hasLetter = /[a-z]/.test(token);
                if (!hasLetter) return false;
                return token.length >= 2;
            });
    }

    private normalizeForMatch(value?: string): string {
        return String(value || '')
            .toLowerCase()
            .replace(/[^a-z0-9\s]/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
    }

    private escapeRegex(value: string): string {
        return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    private containsWholeWord(text: string, token: string): boolean {
        const normalizedText = this.normalizeForMatch(text);
        const normalizedToken = this.normalizeForMatch(token);
        if (!normalizedText || !normalizedToken) return false;
        const pattern = new RegExp(`\\b${this.escapeRegex(normalizedToken)}\\b`, 'i');
        return pattern.test(normalizedText);
    }


    private extractSignalTokens(text?: string): string[] {
        const normalized = this.normalizeForMatch(text);
        if (!normalized) return [];
        const stopwords = new Set([
            'the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'about', 'your', 'their',
            'have', 'has', 'had', 'was', 'were', 'are', 'is', 'who', 'what', 'when', 'where', 'why', 'how',
            'list', 'show', 'find', 'search', 'please', 'could', 'would', 'should', 'there', 'them', 'they',
            'then', 'than', 'also', 'only', 'just', 'more', 'less', 'most', 'least', 'info', 'information',
            'employee', 'employees', 'profile', 'profiles', 'project', 'projects', 'skill', 'skills',
            'certification', 'certifications', 'experience',
        ]);
        const tokens = normalized.split(/\s+/).filter(Boolean);
        const out: string[] = [];
        const seen = new Set<string>();
        for (const token of tokens) {
            if (token.length < 3) continue;
            if (stopwords.has(token)) continue;
            if (seen.has(token)) continue;
            seen.add(token);
            out.push(token);
        }
        return out;
    }

    private buildResultsBlob(results: Array<{
        name: string;
        role?: string;
        experienceYears?: number;
        companies?: string[];
        certifications?: string[];
        projects?: string[];
        skills?: string[];
    }>): string {
        const parts: string[] = [];
        for (const row of results) {
            parts.push(String(row?.name || ''));
            parts.push(String(row?.role || ''));
            if (typeof row?.experienceYears === 'number') {
                parts.push(String(row.experienceYears));
            }
            (row?.companies || []).forEach((v) => parts.push(String(v || '')));
            (row?.certifications || []).forEach((v) => parts.push(String(v || '')));
            (row?.projects || []).forEach((v) => parts.push(String(v || '')));
            (row?.skills || []).forEach((v) => parts.push(String(v || '')));
        }
        return this.normalizeForMatch(parts.join(' '));
    }

    private buildContextBlob(context: any[]): string {
        if (!Array.isArray(context) || context.length === 0) return '';
        const parts: string[] = [];
        for (const item of context) {
            if (typeof item?.content === 'string' && item.content.trim()) {
                parts.push(item.content.trim());
            }
            const meta = item?.metadata || {};
            const push = (value: any) => {
                if (typeof value === 'string' && value.trim()) {
                    parts.push(value.trim());
                }
            };
            push(meta?.name);
            push(meta?.job_title);
            push(meta?.company_name);
            push(meta?.client_name);
            push(meta?.project_name);
            push(meta?.certification_name);
            if (Array.isArray(meta?.certifications)) {
                meta.certifications.forEach((c: any) => push(c));
            }
        }
        return this.normalizeForMatch(parts.join(' '));
    }

    private computeTokenCoverage(tokens: string[], normalizedBlob: string): number {
        if (!tokens.length || !normalizedBlob) return 0;
        let matched = 0;
        for (const token of tokens) {
            if (this.containsWholeWord(normalizedBlob, token) || (token.length >= 5 && normalizedBlob.includes(token))) {
                matched += 1;
            }
        }
        return matched / tokens.length;
    }

    private isQueryGroundedInContext(
        query: string,
        context: any[],
        results: Array<{
            name: string;
            role?: string;
            experienceYears?: number;
            companies?: string[];
            certifications?: string[];
            projects?: string[];
            skills?: string[];
        }>,
    ): boolean {
        // Trust the retriever: if it returned context docs or the results builder
        // found employee cards, the query is related to our employee data.
        // The AI service already has its own grounding (system prompt + safety net).
        if (Array.isArray(context) && context.length > 0) return true;
        if (Array.isArray(results) && results.length > 0) return true;

        // No context at all — the retriever found nothing relevant.
        return false;
    }

    private isAnswerGroundedInResults(
        answer: string,
        results: Array<{
            name: string;
            role?: string;
            experienceYears?: number;
            companies?: string[];
            certifications?: string[];
            projects?: string[];
            skills?: string[];
        }>,
    ): boolean {
        const normalized = this.normalizeForMatch(answer);
        if (!normalized) return false;
        const knownSafeReplies = [
            this.normalizeForMatch(this.ragOutOfScopeMessage),
            this.normalizeForMatch(this.ragNoDataMessage),
        ];
        if (knownSafeReplies.includes(normalized)) return true;

        const answerTokens = this.extractSignalTokens(answer);
        if (!answerTokens.length) return false;
        const resultsBlob = this.buildResultsBlob(results);
        const coverage = this.computeTokenCoverage(answerTokens, resultsBlob);
        return coverage >= 0.3;
    }

    private buildResultsSummary(results: Array<{
        name: string;
        role?: string;
        experienceYears?: number;
        companies?: string[];
        certifications?: string[];
        projects?: string[];
        skills?: string[];
    }>): string {
        if (!Array.isArray(results) || results.length === 0) {
            return this.ragNoDataMessage;
        }
        const lines = results.slice(0, 5).map((row) => {
            const parts: string[] = [];
            parts.push(String(row?.name || '').trim());
            if (row?.role) parts.push(`role: ${row.role}`);
            if (typeof row?.experienceYears === 'number') parts.push(`experience: ${row.experienceYears} years`);
            if (row?.companies?.length) parts.push(`companies: ${row.companies.slice(0, 3).join(', ')}`);
            if (row?.certifications?.length) parts.push(`certifications: ${row.certifications.slice(0, 3).join(', ')}`);
            return parts.filter(Boolean).join(' | ');
        }).filter(Boolean);
        if (!lines.length) return this.ragNoDataMessage;
        return lines.join('\n');
    }

    private buildGroundedAnswer(
        query: string,
        context: any[],
        results: Array<{
            name: string;
            role?: string;
            experienceYears?: number;
            companies?: string[];
            certifications?: string[];
            projects?: string[];
            skills?: string[];
        }>,
        llmAnswer?: unknown,
    ): string {
        const candidate = String(llmAnswer || '').trim();

        // If the AI service returned a direct answer (greeting, meta-response, or
        // 'I don't have that information'), trust it immediately without grounding checks.
        if (candidate && (!Array.isArray(context) || context.length === 0)) {
            return candidate;
        }

        // Gate: if the retriever found nothing related, the query is out of scope.
        if (!this.isQueryGroundedInContext(query, context, results)) {
            return this.ragOutOfScopeMessage;
        }

        // Trust the AI service's LLM answer — it already has its own grounding
        // (system prompt instructs "never invent data" + post-LLM safety net).
        if (candidate) {
            return candidate;
        }

        // Fallback: AI service returned no answer, build summary from results.
        if (!Array.isArray(results) || results.length === 0) {
            return this.ragNoDataMessage;
        }
        return this.buildResultsSummary(results);
    }

    private hasTokenMatch(haystack: string, tokens: string[]): boolean {
        if (!haystack || tokens.length === 0) return false;
        const normalized = this.normalizeForMatch(haystack);
        return tokens.some((token) => {
            if (this.containsWholeWord(normalized, token)) return true;
            return token.length >= 4 && normalized.includes(token);
        });
    }

    private extractMinExperienceYears(query?: string): number | null {
        if (!query) return null;
        const normalized = query.toLowerCase();
        if (!normalized.includes('experience') && !normalized.includes('exp')) return null;
        const match = normalized.match(/(\d+)\s*\+?\s*(?:years?|yrs?|yr|y)\b/);
        if (!match) return null;
        const value = Number.parseInt(match[1], 10);
        return Number.isFinite(value) ? value : null;
    }

    private buildEvidenceText(rawContent: string, meta: any, draft: { certifications: Set<string>; projects: Set<string>; skills: Set<string> }): string {
        const parts: string[] = [];
        if (rawContent) parts.push(rawContent);
        const add = (value: any) => {
            if (typeof value === 'string' && value.trim()) {
                parts.push(value.trim());
            }
        };
        add(meta?.certification_name);
        add(meta?.project_name);
        add(meta?.job_title);
        add(meta?.company_name);
        add(meta?.client_name);
        if (Array.isArray(meta?.certifications)) {
            parts.push(meta.certifications.join(' '));
        }
        if (draft.certifications.size) parts.push(Array.from(draft.certifications).join(' '));
        if (draft.projects.size) parts.push(Array.from(draft.projects).join(' '));
        if (draft.skills.size) parts.push(Array.from(draft.skills).join(' '));
        return parts.join(' ').toLowerCase();
    }

    private async safeLogQuery(
        userId: string | undefined,
        queryText: string,
        extractedEntities: Record<string, any> | null,
        resultCount: number,
        executionTimeMs: number,
    ) {
        try {
            const record = this.searchQueryRepo.create({
                user: userId ? ({ user_id: userId } as User) : null,
                queryText,
                queryIntent: null,
                extractedEntities,
                resultCount,
                executionTimeMs,
            });
            await this.searchQueryRepo.save(record);
        } catch (err) {
            this.logger.warn(`Failed to log AI search query: ${err?.message ?? err}`);
        }
    }
}
