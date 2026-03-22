# Project Diagrams: Proposal Helmsman

This document provides visual representations of the Proposal Helmsman architecture, data flow, and sequence of operations.

## System Flow Diagram
The following flow diagram illustrates the high-level process from RFP ingestion to final proposal export.

```mermaid
graph TD
    A[User Input: RFP Text/Slack Thread] --> B{Proposal Operator}
    B --> C[Parse Skill]
    C --> D[Generate rfp.json]
    D --> E[Plan Skill]
    E --> F[Generate structure.json]
    F --> G[Draft/Revise Skill]
    G --> H[Civic Guardrails]
    H --> I[Generate Sections .md]
    I --> J[Coverage Skill]
    J --> K[Update rfp.json Evidence]
    K --> L[Export Skill]
    L --> M[Download proposal.md]
```

## Data Model Diagram
This diagram shows the relationships between the key data entities stored within a workspace.

```mermaid
erDiagram
    WORKSPACE ||--|| RFP_DOCUMENT : contains
    WORKSPACE ||--|| PROPOSAL_STRUCTURE : contains
    RFP_DOCUMENT ||--o{ REQUIREMENT : defines
    PROPOSAL_STRUCTURE ||--o{ SECTION_DRAFT : references
    REQUIREMENT ||--o{ SECTION_DRAFT : "evidenced by"
    WORKSPACE ||--o{ SLACK_EVENT_RECEIPT : tracks
```

## Sequence Diagram: Section Drafting & Guardrails
This sequence diagram details the interaction between the operator, skills, and external services during a typical drafting and revision workflow.

```mermaid
sequenceDiagram
    participant User
    participant Operator as Proposal Operator
    participant Skill as Drafting Skill
    participant Model as Gemini/LLM
    participant Civic as Civic Guardrails
    participant FS as Workspace (FS)

    User->>Operator: /draft Executive Summary
    Operator->>Civic: Validate Input (Guardrail)
    Civic-->>Operator: Input Allowed
    Operator->>Skill: Execute draft_section
    Skill->>FS: Read rfp.json & structure.json
    FS-->>Skill: Data Loaded
    Skill->>Model: Request Draft Generation
    Model-->>Skill: Generated Markdown
    Skill->>Civic: Validate Output (Guardrail)
    Civic-->>Skill: Output Allowed/Modified
    Skill->>FS: Write sections/executive-summary.md
    Skill->>Operator: Drafting Complete
    Operator->>User: Workspace Updated
```
