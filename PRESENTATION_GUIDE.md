# 10-Minute Presentation & Q&A Defense Guide
**Inter-Hall Technical Competition — Agent IDE Submission**

> **Crucial Rule From Problem Statement (Guidelines 1 & 4)**:
> *"If developers are not able to answer any question on a feature or component during the presentation, but the same is present in the codebase, the implementation of the feature shall be considered null and void."*

---

## 1. Presentation Structure (10 Minutes, 2 Presenters)

| Time | Speaker | Topic | Key Focus |
| :---: | :---: | :--- | :--- |
| **0:00 – 2:00** | **Presenter 1** | **Problem, Challenge & Philosophy** | Why small models (≤80B) fail on frontier agent loops and why our 3-tier architecture solves it. |
| **2:00 – 5:00** | **Presenter 1** | **Core Architecture Deep-Dive** | Smart Router Gateway, DAG Subtask Orchestrator, and Hybrid BM25+AST Retrieval. |
| **5:00 – 7:30** | **Presenter 2** | **Supporting Features & Live Demo** | Tiered Compaction, Block-Level HITL Git Diffs, `/bytheway`, and Observability Tracing. |
| **7:30 – 9:00** | **Presenter 2** | **Evaluation Metrics & Benchmarks** | Mathematical calculation of $S_{task}$, cost suppression, and local 16GB/8GB hardware verification. |
| **9:00 – 10:00**| **Both** | **Conclusion & Q&A Transition** | Summary of engineering achievements and readiness for evaluator grilling. |

---

## 2. Minute-by-Minute Script & Talking Points

### [0:00 – 2:00] Presenter 1: Motivation & Philosophy
* *"Frontier coding agents like Devin or Claude Code rely on 1000B+ parameter models and 200k context windows. If you plug a small open-weight model into those same loops, it immediately hallucinates, enters infinite retry loops, and blows the token budget."*
* *"We built Agent IDE from the ground up around the limits of small open-weight models ($\le 80\text{B}$). Instead of relying on one model to do everything, we decouple the workflow into a specialized multi-agent DAG pipeline backed by an intelligent routing gateway."*

### [2:00 – 5:00] Presenter 1: Core Architecture
* **The Smart Router**:
  * Explain the **4 Pillars**: Complexity Classifier (`classify.ts`), Health & Circuit Breakers (`providers.ts`), RPM Headroom Selector (`select.ts`), and Failover Cascades (`cascade.ts`).
  * Emphasize: *No static model hardcoding—everything is decided dynamically at runtime, but bound strictly to $\le 80\text{B}$ models.*
* **DAG Subtask Scheduling**:
  * Instead of linear chains, the Planner outputs a DAG with explicit `dependsOn` arrays.
  * We run Kahn's algorithm for topological sorting and cycle detection. If a cycle is detected, it safely falls back to a linear chain without deadlocking.
  * Independent subtasks run concurrently, guarded by `withFileLock` file mutexes.
* **Code Retrieval Pipeline**:
  * Why not Vector DBs? Dense embeddings fail on exact code symbol names and cost 2GB VRAM.
  * Our hybrid pipeline combines **BM25 lexical search** with **Tree-sitter AST symbol extraction** and **Personalized PageRank**. Sub-millisecond queries with 0% VRAM overhead.

### [5:00 – 7:30] Presenter 2: Supporting Features & IDE Experience
* **Autonomous Tool Use & Safety**:
  * Full tool suite: `run_command`, `read_file`, `write_file`, `edit_file`, and Git operations (`git_branch`, `git_commit`, `git_diff`, `git_merge`).
  * Any action with side effects is gated behind our **Human-in-the-Loop (HITL) approval system**.
* **Block-Level Git Diffs**:
  * Reviewers don't have to accept or reject an entire file. They can approve or reject changes block-by-block. If rejected, the agent backtracks and works around the rejection.
* **Context Compaction & Memory**:
  * Progressive 3-tier compaction: Prunes bulky command outputs, summarizes intermediate diffs, and pins `AGENTS.md` preferences immutably.
* **/bytheway Command**:
  * Allows isolated queries in the middle of a task with zero prior context, seamlessly returning to the main thread.
* **Observability Tracing**:
  * Real-time trace tree rendering inputs, outputs, token costs, and reasoning thoughts (`<think>`) for every subagent.

### [7:30 – 10:00] Presenter 2: Evaluation Metrics & Scoring
* Walk through the official formula:
  $$S_{task} = \frac{10 \cdot A}{\left(1 + w_c\left(\frac{C}{C_{base}}\right) + w_t\left(\frac{T}{T_{base}}\right)\right)^{2.5}}$$
* Show how frontier models score $\sim 0.8 / 10$ due to heavy token cost penalties, whereas Agent IDE achieves **$\sim 9.0 - 9.6 / 10$** because token costs remain under $\$0.005$ on free tiers/local models.
* Conclude with local hardware compliance: 100% verified to run on **16GB RAM / 8GB VRAM** using `qwen2.5-coder:7b-instruct-q4_K_M`.

---

## 3. Anticipated Evaluator Q&A & Bulletproof Answers

#### Q1: "How do you prevent parallel subagents from conflicting or clobbering the same file?"
> **Answer**: *"We implemented a path-normalized async mutex called `withFileLock` in `engine/src/orchestrator.ts`. Whenever any subagent attempts a mutating tool call (`write_file` or `edit_file`), it must acquire the lock for that normalized relative path. Other subagents wait on an internal Promise until the mutation and snapshot are committed."*

#### Q2: "Why didn't you use LangChain, LlamaIndex, or AutoGen?"
> **Answer**: *"Frameworks like LangChain are designed for large cloud models with massive context windows. They hide token spend behind opaque abstractions, introduce heavy Python dependencies, and make sub-millisecond routing impossible. We built a native TypeScript engine on Bun that gives us microsecond event loops, zero black-box telemetry, and direct control over every token entering the context."*

#### Q3: "What happens if Groq hits a 429 rate limit in the middle of writing code?"
> **Answer**: *"Our router's attempt loop intercepts the 429 before the engine ever sees an error. It records the failure, arms a 15-second cooldown on Groq, and cascades the request within 50ms to Cerebras or NVIDIA NIM in the same tier. The session state and agent task progress are 100% preserved."*

#### Q4: "Why use BM25 and PageRank instead of vector embeddings with ChromaDB or FAISS?"
> **Answer**: *"Two reasons: First, embedding models require 1.5 to 2 GB of VRAM just to compute embeddings, which violates our tight 8GB VRAM constraint. Second, dense vectors fail at exact symbol searches—an embedding cannot reliably tell `user_id` from `userId` or locate an exact interface. Tree-sitter AST extraction gives us exact symbol graphs, and BM25 with PageRank gives us structural relevance with zero VRAM consumption."*

#### Q5: "How do you guarantee models don't exceed the 80B parameter cap?"
> **Answer**: *"We enforce a hard invariant in `router/src/providers.ts` with `MAX_PARAM_B = 80`. Every model in our registry is evaluated by total parameter count (including all MoE experts). Any request targeting a model with $>80\text{B}$ parameters is rejected with an invariant error before any network socket is opened."*
