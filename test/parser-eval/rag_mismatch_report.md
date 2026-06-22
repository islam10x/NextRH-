# RAG Pipeline Evaluation Accuracy Report

This report evaluates the accuracy of the Bid Manager RAG pipeline against curated test cases measuring semantic retrieval quality, groundedness, and safe off-topic guardrails.

## Summary Metrics

| Metric | Target Value | Achieved Value | Status |
| :--- | :---: | :---: | :---: |
| **Retrieval Precision @5** | 87.0% | 82.1% | ❌ FAILED |
| **Answer Groundedness** | 91.0% | 84.2% | ❌ FAILED |
| **Off-Topic Rejection Accuracy** | 100.0% | 100.0% | ✅ PASSED |

## Detailed Evaluation Results

### 1. Retrieval Precision & Groundedness Tests

#### Query: *"what certifications does Yasser Ben Ammar have?"*

- **Retrieved Chunks Count**: 23
- **Precision Score**: 100.0%
- **Groundedness Score**: 94.1%
- **AI Answer**:
  > Yasser Ben Ammar has the following certifications:

- HCIA-AI (Huawei)
- PCAP (Python)
- RHCSA (Linux)
- Fortinet Certified Associate (FCA) Azure-900
- XDR administrator

These certifications are mentioned in his CV and work experience.

#### Query: *"what education does Aya BEN JEMAA have?"*

- **Retrieved Chunks Count**: 22
- **Precision Score**: 100.0%
- **Groundedness Score**: 100.0%
- **AI Answer**:
  > Aya BEN JEMAA has a **Diplôme National d’Ingénieur en Sciences Appliquées et en Technologie Spécialité : Réseaux informatiques et télécommunications** from the **Institut National des Sciences Appliquées et de Technologie « INSAT », Tunis**.

#### Query: *"what projects did Anouar ABDALLAH work on?"*

- **Retrieved Chunks Count**: 42
- **Precision Score**: 100.0%
- **Groundedness Score**: 50.0%
- **AI Answer**:
  > Anouar ABDALLAH worked on the following projects:

1. Smart City Infrastructure
2. Eco-Friendly Energy Solutions

#### Query: *"who has a Red Hat or RHCSA certification?"*

- **Retrieved Chunks Count**: 23
- **Precision Score**: 39.1%
- **Groundedness Score**: 76.9%
- **AI Answer**:
  > Ahmed Khalil Abidi has a Red Hat Certified Associate (RHCSA) certification. Specifically, he holds the following certifications:

- **Red Hat Certified Associate (FCA) Azure-900**
- **Red Hat Certified Associate (FCA) Azure-900**

These certifications indicate that Ahmed Khalil Abidi is proficient in using Red Hat technologies and solutions related to Azure.

#### Query: *"who is a SOC Manager?"*

- **Retrieved Chunks Count**: 21
- **Precision Score**: 71.4%
- **Groundedness Score**: 100.0%
- **AI Answer**:
  > **Amal KHALFAOUI**

### 2. Off-Topic Rejection Tests

#### Query: *"what is the capital of France?"*

- **Correctly Rejected**: True
- **AI Answer**: *"I don't have that information."*

#### Query: *"write a quicksort function in python"*

- **Correctly Rejected**: True
- **AI Answer**: *"I don't have that information."*

#### Query: *"how to bake a chocolate cake?"*

- **Correctly Rejected**: True
- **AI Answer**: *"I don't have that information."*

#### Query: *"what is the weather like in Tunis today?"*

- **Correctly Rejected**: True
- **AI Answer**: *"I don't have that information."*

#### Query: *"who won the last football world cup?"*

- **Correctly Rejected**: True
- **AI Answer**: *"I don't have that information."*
