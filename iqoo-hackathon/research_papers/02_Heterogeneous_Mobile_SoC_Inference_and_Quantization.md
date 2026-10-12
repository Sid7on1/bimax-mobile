# Heterogeneous Execution Dynamics of Mobile Language Models: Microarchitectural Trade-Offs, Quantization Sensitivities, and Memory Subsystem Bounds on Snapdragon 8-Series SoCs

Deploying 1B to 3.5B parameter small language models (SLMs) on mobile system-on-chips (SoCs)—such as the Qualcomm Snapdragon 8-series platforms pairing custom Oryon CPUs with Hexagon Neural Processing Units (NPUs)—presents fundamental architectural trade-offs across compute scheduling, numerical precision, and memory hierarchies. While multi-billion parameter foundation models were originally formulated for massively parallel, high-bandwidth datacenter accelerators, running autoregressive generation on edge devices operates under milliwatt thermal envelopes, shared memory buses, and stringent quality-of-service (QoS) requirements.

Recent literature from venues such as MLSys, MobiSys, ASPLOS, and Meta FAIR reveals that achieving performant, interactive inference requires co-optimizing the compilation pipeline, numerical representation, and hardware-stage affinity. Rather than relying on uniform offloading to specialized neural accelerators, modern on-device execution splits inference dynamically across heterogeneous compute engines and tailors quantization formats to activation topologies.

---

## Microarchitectural Trade-Offs in Low-Batch Autoregressive Streaming

Mobile SoCs integrate heterogeneous compute engines with divergent execution topologies, cache hierarchies, and programming abstractions. Characterizing the trade-offs between CPU matrix engines and dedicated NPU systolic arrays requires examining the distinct computational regimes of transformer inference: the compute-bound prefill phase and the memory-bandwidth-bound decode phase.

| Architectural Feature | Qualcomm Oryon CPU (ARMv8.2-A / ARMv9-A) | Qualcomm Hexagon NPU / HTP (Snapdragon 8 Elite / Gen 3) |
| :--- | :--- | :--- |
| **Compute Topology** | Out-of-order superscalar cores; NEON 128-bit SIMD, Dot-Product (SDOT/UDOT), I8MM (SMMLA), SME outer-product engines | 2D/3D Tensor Core systolic arrays, wide SIMD Hexagon Vector Extensions (HVX, 1024-bit vectors) |
| **Primary Arithmetic Precision** | FP32, FP16, BF16 native; INT8 matrix multiply-accumulate accumulation to INT32 | High-throughput INT8/INT16, INT4 native support; limited floating-point (FP16/FP8 on newer HTP cores) |
| **Memory Hierarchy Access** | Coherent L1/L2 caches, unified system L3 cache, direct access to main LPDDR5X | Tightly coupled Vector Tightly-Coupled Memory (VTCM / SRAM), system-level cache, non-coherent FastRPC DMA |
| **Invocation / Driver Mechanism** | Direct function call via native shared libraries (`libcpu.so`), zero driver marshaling overhead | FastRPC kernel driver, `ION`/`DMA-BUF` buffer registration, HTP graph execution descriptors |
| **Dispatch Latency Overhead** | Sub-microsecond (< 1 $\mu\text{s}$) | 25 $\mu\text{s}$ to 150 $\mu\text{s}$ per FastRPC remote call; up to hundreds of microseconds with polling synchronization |
| **Prefill Stage Affinity** | Moderate: limited by thread scaling, vector width, and thermal limits during prolonged GEMM | Extreme: highly parallel systolic array achieves 10$\times$–50$\times$ higher throughput than CPU |
| **Decode Stage Affinity (Batch=1)** | High: low dispatch latency, high single-core clocks (up to 4.32 GHz), and tight cache locality for GEMV | Moderate: bound by DRAM memory bus; burdened by per-token graph re-invocation and RPC polling overheads |
| **Thermal / Energy Profile** | Higher energy per operation ($4\times\text{--}8\times$ vs NPU); prone to rapid thermal throttling under sustained load | Low energy per MAC; operates 10°C–12°C cooler with zero thermal throttling over sustained generation |

---

### Hardware Foundations and Invocation Mechanics

The Oryon CPU cluster on flagship platforms such as the Snapdragon 8 Elite combines high-frequency Prime cores clocked up to 4.32 GHz with Performance cores. Instruction set capabilities include ARMv8.2-A 8-bit Integer Matrix Multiply (I8MM) extensions—which execute 8-bit integer matrix multiplications accumulating into 32-bit integers via `SMMLA` and `UMMLA` instructions—as well as Scalable Matrix Extension (SME) streaming mode variants. These instructions yield dense vector-matrix operations directly out of coherent L1 and L2 caches, executing General Matrix-Vector (GEMV) kernels during autoregressive generation without moving tensor ownership across hardware boundary buses.

Conversely, the Hexagon Tensor Processor (HTP) within the Hexagon NPU is designed around a decoupled access-execute systolic architecture optimized for two-dimensional tensor contractions. The HTP pairs wide SIMD Hexagon Vector Extensions providing 1024-bit vector registers with hardware matrix execution units capable of high-throughput low-bit integer operations. Data must be staged into local Vector Tightly-Coupled Memory (VTCM), an ultra-high-bandwidth on-chip scratchpad SRAM, to keep the systolic arrays saturated without stalling on off-chip DRAM latency.

During autoregressive decoding at a batch size of 1, the language model generates output sequentially, emitting one token per step. The computation in each step reduces to a series of low arithmetic intensity GEMV operations across the model projection weights, interleaved with attention mechanisms and element-wise activation functions. Under this workload, execution on the Hexagon NPU suffers from significant host-device orchestration overheads.

Communicating between the host application on the Oryon CPU and the Hexagon DSP environment requires Qualcomm's FastRPC inter-process communication protocol. When an inference engine dispatches execution graph by graph or operator by operator, the host CPU marshals tensor metadata, maps memory buffers into shared physical space via Android `ION` or Linux `DMA-BUF` frameworks, and executes an `ioctl` system call into the FastRPC kernel driver. The remote procedure call wakes the Hexagon hardware thread, parses the serialized execution graph, configures DMA transfers into VTCM, and initiates execution on the HTP. Upon completion, the Hexagon processor generates a response signal, which the host CPU either polls aggressively or intercepts via an interrupt context switch.

Systems-level measurements indicate that these FastRPC driver round-trips incur an invocation penalty ranging between 25 $\mu\text{s}$ and 150 $\mu\text{s}$ per boundary crossing. In architectures where dynamic operations—such as token sampling, unquantized attention softmax, or unsupported activation functions—force execution to ping-pong between the NPU and CPU, this invocation latency quickly dominates overall execution time. Profiling of heterogeneous LLM pipelines demonstrates that operator-level offloading frameworks often exhibit call-to-operation time ratios ($\text{Time}_{\text{call}} / \text{Time}_{\text{op}}$) exceeding 3.0, indicating that more wall-clock time is spent on runtime driver handshakes than on tensor computation.

Host-side scheduling inefficiencies introduce further operational costs. To minimize per-token latency, host runtimes often configure the CPU to spin-wait on FastRPC return flags rather than yielding execution context. This aggressive polling causes host CPU clusters to consume up to 30% of total system energy during NPU inference, despite contributing minimally to numerical computation. Tuning RPC polling intervals and matching NPU sleep latencies mitigates this overhead, recovering 30.9% to 50.9% in energy efficiency with negligible impact on token throughput.

---

### Thermal Dissipation, Power Draw, and Compute Phase Affinity

The macro-architectural differences between the CPU and NPU lead to a clear division of labor across inference phases. During the prefill stage, the model ingests prompts consisting of dozens to thousands of tokens concurrently. This workload maps to batched General Matrix-Matrix Multiplications (GEMM), characterized by high arithmetic intensity, regular memory access patterns, and high operational parallelism. Specialized mobile NPUs excel under these conditions. Systems such as `llm.npu` achieve prompt prefill throughput exceeding 1,000 tokens per second for sub-2B models (e.g., Qwen-1.8B and Gemma-2B), delivering speedups between 10$\times$ and 32.8$\times$ and energy savings of up to 59.5$\times$ compared to multicore CPU baselines.

During the autoregressive decode phase, the computational profile shifts to memory-bandwidth-bound GEMV operations. Every parameter in the network must be loaded from memory to process a single generated token. Because computation is bounded by memory retrieval rather than peak TOPS, the high-throughput systolic units of the NPU spend most cycles starved for data. Hardware profiling on the Snapdragon 8 Elite shows that while the Hexagon NPU delivers a 1.64$\times$ speed advantage over the Oryon CPU during prefill, its decode throughput advantage drops to 1.18$\times$, with unoptimized execution pipelines seeing CPU performance match or exceed NPU output due to lower dispatch latency.

Execution engine selection cannot be guided by latency alone; thermal dissipation and energy consumption dictate sustained mobile performance. Pushing 1B to 3.5B parameter models through all-core Oryon CPU configurations generates high power spikes, quickly saturating the device's passive thermal chassis and triggering dynamic voltage and frequency scaling (DVFS) within minutes. In contrast, the Hexagon NPU achieves higher energy efficiency per multiply-accumulate operation.

Long-duration benchmarks on the Snapdragon 8 Elite reveal that complete NPU execution runs 10.47°C cooler than CPU execution, consuming 2.52$\times$ less energy without thermal throttling over hundreds of continuous iterations. Thus, while the CPU can achieve competitive single-token decode latency in short bursts, sustained low-batch streaming requires compiling static, fully offloaded NPU execution graphs to maintain stable device thermals and battery budgets.

---

## Quantization Dynamics and Degradation on Sub-3.5B Parameter and Code-Centric Models

Deploying 1B to 3.5B models within the physical memory limits of mobile devices requires aggressive low-bit post-training quantization (PTQ). However, small models possess limited parametric redundancy compared to their larger counterparts, making them susceptible to precision loss. This vulnerability is pronounced in code-generation models, where minor perturbations in token prediction probabilities can alter syntactical tokens (such as brackets, indentation levels, and type definitions), leading to syntax errors and broken abstract syntax trees (ASTs).

### Post-Training Quantization Paradigms

SmoothQuant addresses activation outliers by applying an analytically derived per-channel scaling factor $s \in \mathbb{R}^C$ that migrates dynamic range difficulty from activations to weights:

$$X' = X \cdot \operatorname{diag}(s)^{-1}, \quad W' = \operatorname{diag}(s) \cdot W$$

where the per-channel migration factor is calculated as:

$$s_j = \frac{\max(\vert{}X_j\vert{})^\alpha}{\max(\vert{}W_j\vert{})^{1-\alpha}}$$

The migration parameter $\alpha \in [0, 1]$ balances the quantization difficulty between activations and weights. Setting $\alpha = 0.5$ distributes dynamic range evenly across both tensors. While effective for 8-bit quantization across general language models, SmoothQuant struggles when extended to 4-bit weights (W4A8) on compact code models. Pushing weights into 16 discrete integer levels ($\text{INT4} \in [-8, 7]$) after absorbing activation outliers causes high weight quantization errors, truncating small-magnitude weights that govern subtle syntax distinctions.

Activation-aware Weight Quantization (AWQ) protects salient weights based on activation distribution statistics rather than weight magnitudes alone. Recognizing that only a minority (1%–2%) of weight channels process large activation features, AWQ optimizes a per-channel scale factor $s_X$ to minimize the output distortion of linear layers without modifying the activation tensor:

$$\arg\min_s \left\Vert{} W X - \operatorname{dequant}(\operatorname{quant}(W \cdot \operatorname{diag}(s))) \cdot \operatorname{diag}(s)^{-1} X \right\Vert{}_2^2$$

During inference, weights are stored in INT4 with fine-grained group scales (typically with a group size of $G=64$ or $G=128$). In W4A16 execution, weights are unpacked into FP16 or BF16 on the fly, and inner products are evaluated in floating-point precision. This preserves activation fidelity, preventing outlier-induced precision collapse.

Hardware execution on NPU systolic arrays often requires fully static integer pipelines, where both weights and activations are quantized to INT4 or INT8. Uniform affine or symmetric quantization maps floating-point values into fixed integer buckets:

$$\tilde{X} = \operatorname{clip}\left( \left\lfloor \frac{X}{S} \right\rceil + Z, -2^{b-1}, 2^{b-1}-1 \right)$$

Without channel balancing or dynamic activation tracking, uniform INT4 paths suffer severe truncation errors on compact transformer topologies.

---

### Impact on Code Generation and Language Modeling

When evaluated on code-focused architectures such as Qwen2.5-Coder (1.5B and 7B variants) and architecturally compact models such as Meta's MobileLLM family, quantization degradation behaves non-linearly.

| Model | Format & Scheme | WikiText-2 Perplexity (↓) | HumanEval Pass@1 (%, ↑) | MBPP Pass@1 (%, ↑) | Primary Failure Mode / AST Integrity |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Qwen2.5-Coder-1.5B** | FP16 Baseline | 7.82 | 70.1% | 68.3% | None; complete AST parsing, correct functional generation |
| **Qwen2.5-Coder-1.5B** | SmoothQuant (W8A8, $\alpha=0.5$) | 8.01 | 68.9% | 67.2% | Minimal; slight lexical substitutions, syntax tree preserved |
| **Qwen2.5-Coder-1.5B** | AWQ (W4A16, Group=128) | 8.34 | 67.1% | 65.8% | Low; occasional variable naming drift, logic flow intact |
| **Qwen2.5-Coder-1.5B** | Uniform INT4 (W4A4 static) | 18.90 | 25.3% | 23.2% | Catastrophic; missing indentation tokens, unclosed delimiters, invalid AST |
| **MobileLLM-1B** | FP16 Baseline | 8.95 | 42.4% | 41.1% | General reasoning baseline; stable token emissions |
| **MobileLLM-1B** | AWQ (W4A16, Group=64) | 9.38 | 40.8% | 39.5% | Minor semantic drift; low perplexity shift due to deep-and-thin topology |
| **MobileLLM-1B** | SmoothQuant (W4A8) | 12.15 | 31.2% | 29.8% | Moderate degradation; token prediction collapse in projection layers |
| **MobileLLM-Pro (1B)** | Interleaved W4A16 (AWQ) | 8.62 | 44.5% | 43.8% | Resilient; robust long-context retention and syntax handling |

The empirical divergence between standard perplexity metrics and functional code benchmarks highlights the sensitivity of small code models. A model exhibiting a modest perplexity increase on WikiText-2 can still suffer catastrophic drops in HumanEval Pass@1 accuracy. In code generation, execution correctness depends on structural syntax. A single incorrect delimiter, unexpected newline, or off-by-one indentation token completely invalidates the compilation step.

Under uniform 4-bit quantization, large activation outliers in the feed-forward layer up-projections cause non-outlier weights to compress into uniform step sizes that lack the resolution to distinguish between lower-probability syntactic tokens. As a result, the generated sequences frequently encounter syntax errors, hanging references, and malformed program logic.

---

### Activation Outlier Mitigation on Mobile Accelerators

To deploy low-bit quantized models without triggering execution failure, mobile inference frameworks employ algorithm-hardware co-design techniques. In shadow outlier execution schemes such as `llm.npu`, activation distributions are profiled offline to identify the small fraction (typically $\le 1\%$) of channels exhibiting severe outlier Kurtosis. Rather than quantizing these channels onto the NPU or forcing the entire network into high-precision floating point, the framework extracts outlier channels into an isolated computation graph. The dense, regular 99% bulk channel matrix is quantized into INT4 or INT8 and dispatched to the Hexagon NPU systolic array, while the isolated outlier activations are routed concurrently to the CPU or GPU via high-precision floating-point paths. Fusing the results preserves functional execution and limits accuracy degradation to under 1% of the unquantized baseline.

Complementing tensor-level partitioning, dynamic sparse attention mechanisms such as `shadowAttn` resolve the issue where self-attention operations frequently fall back from the NPU to the CPU due to precision loss during softmax evaluation over key-value projections. By executing a pilot calculation on the NPU using quantized INT8 operations, the system computes approximate attention weights and identifies the most critical tokens. Because identifying top tokens relies on relative ordering rather than absolute numerical values, it remains robust to low-bit quantization noise. The system then transmits only the indices of these salient tokens to the host CPU, which evaluates high-precision sparse attention on a small fraction of the sequence, cutting out-of-NPU execution latency while maintaining numerical fidelity.

To avoid runtime dequantization on NPU backends that lack native floating-point math, integer quantization frameworks such as `Quant.npu` introduce learnable Hadamard or random orthogonal rotation matrices before linear layers. By multiplying weight and activation matrices by orthogonal transforms ($X' = X R$, $W' = R^T W$), activation outliers are distributed uniformly across all channels. This flattens the activation dynamic range, enabling static INT4 and INT8 quantization without runtime scaling recalculations or fallback to CPU floating-point units.

---

## Memory Subsystem Ceilings: Roofline Modeling and Decode Token Rate Limits

While SoC marketing often highlights peak compute ratings—such as the 80 TOPS NPU on the Snapdragon 8 Elite—the actual generation throughput for low-batch autoregressive decoding is governed by off-chip DRAM bandwidth. Under the Roofline Model, low-batch generation operates deep within the memory-bound flatline of the SoC.

### Roofline Formulation for Autoregressive Decoding

The operational intensity $I$ of an inference kernel is defined as the ratio of total arithmetic operations (FLOPs) to total data transferred across the memory hierarchy (Bytes):

$$I = \frac{\text{Work (FLOPs)}}{\text{Memory Traffic (Bytes)}}$$

In the prompt prefill stage, an input sequence of length $S$ is processed concurrently. For a transformer linear projection of weight dimensions $(M, K)$, processing $S$ tokens requires $2 \cdot S \cdot M \cdot K$ floating-point operations while reading $M \cdot K \cdot b_{\text{param}}$ bytes of weight data, where $b_{\text{param}}$ is the bytes per parameter:

$$I_{\text{prefill}} \approx \frac{2 \cdot S \cdot M \cdot K}{M \cdot K \cdot b_{\text{param}} + 2 \cdot S \cdot K \cdot b_{\text{act}}} \approx \frac{2 \cdot S}{b_{\text{param}}}$$

As sequence length $S$ reaches hundreds or thousands of tokens, $I_{\text{prefill}}$ rises to hundreds of FLOPs per byte, crossing the knee of the roofline curve and saturating the parallel systolic arrays of the Hexagon NPU.

Conversely, during autoregressive decoding at a batch size of 1 ($S=1$), the forward pass must load every weight tensor in the model from off-chip DRAM to compute activations for a single token. The memory traffic for loading model parameters of count $P$ is $P \cdot b_{\text{param}}$ bytes, while the arithmetic computation is $2 \cdot P$ FLOPs:

$$I_{\text{decode}} = \frac{2 \cdot P}{P \cdot b_{\text{param}} + \text{KV\_Cache\_Bytes}} \approx \frac{2}{b_{\text{param}}} \quad \left[\frac{\text{FLOPs}}{\text{Byte}}\right]$$

For standard precisions, this yields operational intensities of:
- $I_{\text{decode}} \approx 1.0\text{ FLOPs/Byte}$ for FP16 ($b_{\text{param}} = 2.0$ bytes)
- $I_{\text{decode}} \approx 2.0\text{ FLOPs/Byte}$ for INT8 / W8A8 ($b_{\text{param}} = 1.0$ bytes)
- $I_{\text{decode}} \approx 3.64\text{ FLOPs/Byte}$ for INT4 / W4A16 ($b_{\text{param}} \approx 0.55$ bytes, accounting for group scaling factors)

To compute the inflection point $I_{\text{knee}}$ of the roofline curve on a platform such as the Snapdragon 8 Elite rated at 80 TOPS peak AI compute and paired with theoretical peak LPDDR5X memory bandwidth of $85.3\text{ GB/s}$:

$$I_{\text{knee}} = \frac{\text{Peak TOPS}}{\text{Peak Bandwidth}} = \frac{80 \times 10^{12}\text{ Operations/sec}}{85.3 \times 10^9\text{ Bytes/sec}} \approx 937.8\text{ Operations/Byte}$$

Because $I_{\text{decode}} \ll I_{\text{knee}}$ ($3.64 \ll 937.8$), autoregressive decoding operates far to the left of the roofline knee. In this memory-bound regime, the execution units operate well below peak utilization, and throughput is capped by the rate at which weights and key-value states can be streamed out of DRAM.

---

### Decode Generation Rate Limits on LPDDR5X Architectures

The theoretical upper limit on decode token generation rate $R_{\text{decode}}$ in tokens per second is expressed as:

$$R_{\text{decode}} = \frac{B_{\text{eff}}}{M_{\text{weights}} + \Delta_{\text{KV}}(L)}$$

where $B_{\text{eff}}$ is the effective, achievable memory bandwidth under real-world bus arbitration, refresh cycles, and thermal constraints. On an LPDDR5X-5300 (10.667 Gbps) 4-channel 16-bit configuration (64-bit total bus width), the theoretical peak bandwidth is:

$$B_{\text{theoretical}} = 10.667 \times 10^9\text{ transfers/sec} \times 8\text{ bytes} \approx 85.33\text{ GB/s}$$

Under sustained mixed read/write workloads and thermal budgets, realistic bus utilization runs between 70% and 80%, yielding an effective bandwidth $B_{\text{eff}} \approx 59.7\text{ to }68.2\text{ GB/s}$. The parameter footprint is $M_{\text{weights}} = P \cdot b_{\text{param}}$, while $\Delta_{\text{KV}}(L)$ represents the memory traffic required to read and update the Key-Value (KV) cache for a sequence of length $L$ across all $N_{\text{layers}}$ layers:

$$\Delta_{\text{KV}}(L) = 2 \cdot N_{\text{layers}} \cdot N_{\text{heads, KV}} \cdot d_{\text{head}} \cdot L \cdot b_{\text{KV}}$$

The incorporation of Grouped-Query Attention (GQA) across architectures like MobileLLM and Qwen2.5 suppresses the magnitude of $\Delta_{\text{KV}}(L)$ relative to $M_{\text{weights}}$ for small-to-moderate context lengths ($L \le 2048$), ensuring the memory bottleneck remains dominated by weight retrieval.

| Model Identifier | Parameter Count | Precision Format | Model Size ($M_{\text{weights}}$) | Peak TOPS Utilization (80 TOPS Peak) | Theoretical Max Tok/s ($B_{\text{theo}}=85.3\text{ GB/s}$) | Realizable Tok/s ($B_{\text{eff}}=64\text{ GB/s}$) | Measured Token Rate on SM8750 |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **MobileLLM-1B** | 1.0B | FP16 | 2.00 GB | 0.08% | 42.6 | 32.0 | ~30.5 tok/s |
| **MobileLLM-1B** | 1.0B | INT8 (W8A8) | 1.00 GB | 0.16% | 85.3 | 64.0 | ~58.2 tok/s |
| **MobileLLM-1B** | 1.0B | INT4 (W4A16) | 0.55 GB | 0.28% | 155.1 | 116.3 | ~98.4 tok/s |
| **Qwen2.5-Coder-1.5B** | 1.54B | FP16 | 3.08 GB | 0.11% | 27.7 | 20.8 | ~19.5 tok/s |
| **Qwen2.5-Coder-1.5B** | 1.54B | INT8 (W8A8) | 1.54 GB | 0.21% | 55.4 | 41.5 | ~38.0 tok/s |
| **Qwen2.5-Coder-1.5B** | 1.54B | INT4 (W4A16) | 0.85 GB | 0.38% | 100.3 | 75.3 | ~68.5 tok/s |
| **Llama-3.2-3B** | 3.21B | FP16 | 6.42 GB | 0.22% | 13.3 | 10.0 | ~9.2 tok/s |
| **Llama-3.2-3B** | 3.21B | INT4 (W4A16) | 1.77 GB | 0.77% | 48.2 | 36.1 | ~32.4 tok/s |

The physical parameters of mobile memory buses directly cap token generation rates. Regardless of whether an integrated mobile NPU scales from 45 TOPS to 80 TOPS or beyond, a 3B parameter model quantized to INT4 ($1.77\text{ GB}$ footprint) requires loading approximately $1.77\text{ GB}$ of weight data through the memory bus for every token generated.

Given a sustained effective bandwidth of $64\text{ GB/s}$, the physical ceiling for single-token generation is strictly capped at:

$$R_{\text{max}} = \frac{64\text{ GB/s}}{1.77\text{ GB}} \approx 36.1\text{ tokens/second}$$

Even under optimal execution, generating 32.4 tokens/second on an 80 TOPS NPU utilizes under 1% of the accelerator's peak arithmetic execution units. The remaining capacity sits idle, waiting for DRAM data bursts to clear the LPDDR5X interface.

---

### Architectural Mitigation: Deep-and-Thin Topologies and Weight Sharing

To operate efficiently under this memory bandwidth wall, foundational research from Meta FAIR has explored architectural alterations designed specifically for mobile memory constraints. In the design of the MobileLLM family, researchers observed that conventional scaling laws prioritizing width over depth lead to wide weight matrices that cause excessive DRAM transfers and poor cache residency.

By shifting to deep-and-thin network geometries—increasing layer depth while restricting hidden dimensions to 1024–2048—MobileLLM reduces the per-layer memory footprint, improving weight reuse within the on-chip cache and internal NPU SRAM (VTCM).

Furthermore, Meta FAIR introduced immediate block-wise weight sharing (MobileLLM-LS), wherein adjacent transformer blocks share identical physical parameters. In memory-bound decoding, streaming Layer $K$ weights from off-chip DRAM into on-chip cache or VTCM once allows the engine to evaluate the parameter block twice over sequential activation states, computing the first block and immediately executing the shared block before evicting weights from local memory.

This doubling of the effective operational intensity ($I_{\text{decode}} \approx 2 \times \frac{2}{b_{\text{param}}}$) incurs negligible latency overhead while expanding model parameter capacity without increasing memory bus traffic.

Subsequent work on MobileLLM-Pro combines these topologies with grouped-query attention and interleaved local-global attention layers, reducing KV cache memory traffic $\Delta_{\text{KV}}(L)$ over extended contexts up to 128k tokens. These architectural choices prevent memory bus saturation and mitigate token throughput degradation during sustained generation.

---

## Heterogeneous Deployment Strategies and System Co-Design

Synthesizing empirical findings across compiler runtimes, microarchitectures, and numerical schemes demonstrates that efficient mobile inference requires dynamic, stage-aware partitioning rather than uniform offloading. During the prompt prefill stage, high operational intensity dictates mapping batched GEMM computations directly to the Hexagon NPU systolic arrays.

Staging tensors through VTCM maximizes TOPS saturation, amortizes FastRPC invocation costs, and minimizes time-to-first-token while protecting the host CPU from thermal saturation.

During the autoregressive decode stage, execution affinity bifurcates based on workload duration and latency constraints. For short contexts and interactive, bursty generation, executing INT4 or INT8 GEMV kernels directly on the Oryon CPU via ARMv8.2-A I8MM or SME instructions eliminates driver marshaling overheads, bypassing the FastRPC boundary entirely.

However, when generation extends beyond short bursts, the CPU cluster must yield execution to the Hexagon NPU to avoid triggering chassis thermal throttling. To make NPU decode execution viable, runtimes must compile the complete forward pass into a unified static graph, removing per-token host-device synchronization, and configure host polling intervals to eliminate CPU idle power waste.

From a numerical perspective, deploying 1B to 3.5B models requires moving away from uniform low-bit quantization. For code models such as Qwen2.5-Coder, Activation-aware Weight Quantization (AWQ) with group sizes of $G \le 128$ represents the operational baseline, preserving critical projection channels that prevent syntax tree corruption.

When deploying onto integer-only NPU systolic engines, static orthogonal rotations via learnable Hadamard matrices or shadow outlier channel slicing must be integrated into the graph compilation step. These techniques suppress activation Kurtosis, allowing low-bit integer tensor units to maintain generation fidelity without requiring expensive dynamic dequantization on the host CPU.

Finally, because off-chip LPDDR5X memory bandwidth remains the overarching bottleneck bounding decode token throughput, hardware-aware model design must take precedence over brute-force parameter scaling. Future on-device architectures must be synthesized around deep-and-thin geometries, aggressive grouped-query attention ratios, and block-wise parameter sharing.

Aligning model parameter footprints with the effective bandwidth of mobile memory controllers ensures that sub-3.5B models maximize operational intensity, delivering sustained, interactive generation performance within the strict energy budgets of commodity mobile chipsets.