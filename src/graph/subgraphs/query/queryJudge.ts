import type { Logger } from 'winston';
import { parseLlmJson } from '../../../core/parseLlmJson.js';
import type { LlmProvider } from '../../../infrastructure/llm/LlmProvider.js';
import {
  type SqlJudgeArgs,
  type SynthesisJudgeArgs,
  buildSqlJudgePrompt,
  buildSynthesisJudgePrompt,
} from './prompts/judgePrompts.js';

/**
 * LLM-as-a-Judge para el pipeline freeform_sql. Port adaptado de IDP_OV1
 * `QueryJudge`. Dos validaciones independientes:
 *
 *   1. `validateSql`  — post-ejecución: ¿el SQL responde la pregunta? ¿filtro
 *      de perfil presente? ¿resultados coherentes? ¿schema alineado?
 *   2. `validateSynthesis` — post-síntesis: ¿la respuesta NL refleja fielmente
 *      los rows sin inventar nada?
 *
 * Si el judge rechaza, `critique` es el feedback para reintentar.
 *
 * **Fail-mode**: ante fallo del LLM (stopReason='error', §11.3) o JSON no
 * parseable, el verdict default depende de `failMode`:
 *   - `'fail-open'` (default prod): aprueba — no bloquear al usuario por un
 *     error del propio judge.
 *   - `'fail-closed'`: rechaza — útil si se prefiere degradar al fallback
 *     determinístico ante incertidumbre.
 */

export type JudgeFailMode = 'fail-open' | 'fail-closed';

export interface JudgeVerdict {
  approved: boolean;
  reason: string;
  confidence: number;
  critique: string;
}

export interface QueryJudgeConfig {
  model: string;
  temperature: number;
  maxTokens: number;
  failMode: JudgeFailMode;
}

const APPROVED_ON_ERROR: JudgeVerdict = {
  approved: true,
  reason: 'judge_error_fail_open',
  confidence: 0,
  critique: '',
};

const REJECTED_ON_ERROR: JudgeVerdict = {
  approved: false,
  reason: 'judge_unavailable_fail_closed',
  confidence: 0,
  critique: '',
};

export class QueryJudge {
  constructor(
    private readonly llm: LlmProvider,
    private readonly logger: Logger,
    private readonly config: QueryJudgeConfig,
  ) {}

  async validateSql(args: SqlJudgeArgs): Promise<JudgeVerdict> {
    const prompt = buildSqlJudgePrompt(args);
    return this.runJudge(prompt.system, prompt.user, 'query.judge.sql');
  }

  async validateSynthesis(args: SynthesisJudgeArgs): Promise<JudgeVerdict> {
    const prompt = buildSynthesisJudgePrompt(args);
    return this.runJudge(prompt.system, prompt.user, 'query.judge.synthesis');
  }

  private async runJudge(system: string, user: string, component: string): Promise<JudgeVerdict> {
    const response = await this.llm.complete({
      model: this.config.model,
      temperature: this.config.temperature,
      maxTokens: this.config.maxTokens,
      system,
      messages: [{ role: 'user', content: user }],
    });

    // §11.3: complete no lanza; ante fallo del SDK emite stopReason='error'.
    if (response.stopReason === 'error' || response.text.length === 0) {
      this.logger.warn(`${component}: LLM unavailable, applying failMode`, {
        failMode: this.config.failMode,
      });
      return this.defaultForFailMode();
    }

    const parsed = parseLlmJson<{
      approved?: boolean;
      confidence?: number;
      critique?: string;
      reason?: string;
    }>(response.text, this.logger, { component });

    if (!parsed) {
      this.logger.warn(`${component}: verdict not parseable, applying failMode`, {
        failMode: this.config.failMode,
      });
      return this.defaultForFailMode();
    }

    return {
      approved: parsed.approved === true,
      reason: parsed.reason ?? '',
      confidence: parsed.confidence ?? 0,
      critique: parsed.critique ?? '',
    };
  }

  private defaultForFailMode(): JudgeVerdict {
    return this.config.failMode === 'fail-closed' ? REJECTED_ON_ERROR : APPROVED_ON_ERROR;
  }
}
