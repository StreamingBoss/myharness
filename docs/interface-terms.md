# Interface terms

Fixed translations of recurring terms in the MyHarness interface, per language. "harness" and "agent" are fixed in
[AGENTS.md](../AGENTS.md) ("Interface languages"); this file holds the others. Once a term is here, every text in
that language uses it. Changing one means updating the whole catalog (`web/static/i18n-<lang>.js`) at once.

Columns: memory · tool · token · prompt / system prompt · context · session · approval (Approve / Deny) · skill ·
subagent · compaction (Compact) · workspace · request · provider · thinking.

| Language | memory | tool | token | prompt / system prompt | context | session | approval (Approve / Deny) | skill | subagent | compaction (Compact) | workspace | request | provider | thinking |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| fr | mémoire | outil | token | prompt / prompt système | contexte | session | autorisation (Autoriser / Refuser) | skill (un skill) | sous-agent | compaction (Compacter) | espace de travail | requête | fournisseur | raisonnement |
| es | memoria | herramienta | token | prompt / prompt de sistema | contexto | sesión | aprobación (Aprobar / Denegar) | skill (la skill) | subagente | compactación (Compactar) | espacio de trabajo | petición | proveedor | razonamiento |
| pt | memória | ferramenta | token | prompt / prompt de sistema | contexto | sessão | aprovação (Aprovar / Negar) | skill (a skill) | subagente | compactação (Compactar) | workspace | requisição | provedor | raciocínio |
| de | Gedächtnis | Tool | Token | Prompt / Systemprompt | Kontext | Session | Freigabe (Freigeben / Ablehnen) | Skill (der Skill) | Subagent | Kompaktierung (Kompaktieren) | Arbeitsbereich | Anfrage | Anbieter | Denkprozess |
| it | memoria | tool (il tool) | token | prompt / system prompt | contesto | sessione | approvazione (Approva / Rifiuta) | skill (la skill) | subagente | compattazione (Compatta) | workspace | richiesta | provider | ragionamento |
| tr | bellek | araç | token | prompt / sistem prompt’u | bağlam | oturum | onay (Onayla / Reddet) | skill (skill’ler) | alt agent | sıkıştırma (Sıkıştır) | çalışma alanı | istek | sağlayıcı | düşünme |
| zh | 记忆 | 工具 | token | 提示词 / 系统提示词 | 上下文 | 会话 | 审批（批准 / 拒绝） | 技能 | 子 Agent | 压缩 | 工作区 | 请求 | 提供商 | 思考过程 |
| ja | メモリ | ツール | トークン | プロンプト / システムプロンプト | コンテキスト | セッション | 承認（承認 / 拒否） | スキル | サブエージェント | 圧縮 | ワークスペース | リクエスト | プロバイダー | 思考 |
| ko | 메모리 | 도구 | 토큰 | 프롬프트 / 시스템 프롬프트 | 컨텍스트 | 세션 | 승인 (승인 / 거부) | 스킬 | 서브에이전트 | 압축 | 작업 공간 | 요청 | 제공업체 | 사고 과정 |
| ru | память | инструмент | токен | промпт / системный промпт | контекст | сессия | подтверждение (Разрешить / Отклонить) | навык | субагент | сжатие (Сжать) | рабочая папка | запрос | провайдер | размышления |
| hi | मेमोरी (f) | टूल / टूल्स | टोकन / टोकन्स | प्रॉम्प्ट / सिस्टम प्रॉम्प्ट | कॉन्टेक्स्ट | सेशन (m) | अप्रूवल (m) (अप्रूव करें / अस्वीकार करें) | स्किल / स्किल्स (f) | सबएजेंट | कॉम्पैक्शन (कॉम्पैक्ट करें) | वर्कस्पेस | रिक्वेस्ट (f) | प्रोवाइडर | थिंकिंग |

Other choices worth keeping:

- **Register.** Each language follows its harnessarium.com page: fr *vous*; es, pt, it, tr informal (*tú*, *você*, *tu*, *sen*); de *du*; ja です・ます; ko 합니다체.
- **Names on screen.** "Under the hood" / "Internals": fr Sous le capot / Détails internes; es Bajo el capó / Detalles internos;
  pt Por baixo dos panos / Bastidores; hi अंदर की झलक / इंटरनल्स; de Unter der Haube / Interna; it Sotto il cofano / Dettagli interni; tr Perde arkası /
  İç işleyiş; zh 幕后 / 内部细节; ja 内部動作 / 内部ログ; ko 내부 동작 / 내부 통신; ru Под капотом / Изнутри.
- **API key.** fr clé d’API; es clave de API; de API-Key; ru API-ключ; others keep "API key" or its usual local form.
- **Master / child agent** (orchestration): the master is the main agent (fr agent principal, es agente principal, ru главный агент…);
  children are subagents, not "children".
- **Log section titles** (SENT, RECEIVED, TOKENS…) are translated in capitals where the script has capitals; zh, ja and ko
  translate them as plain words; hi keeps them in English.
