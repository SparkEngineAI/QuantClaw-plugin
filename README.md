<p align="center">
  <img src="./figs/favicon.png" alt="QuantClaw logo" width="240">
</p>

<h1 align="center">QuantClaw: Precision Where It Matters for OpenClaw</h1>

<p align="center">
  <a href="./README_zh.md">中文文档</a>
</p>

<div align="center">
  <p>
    <a href="https://clawhub.ai/plugins/%40sparkengineai%2Fquantclaw"><img src="https://img.shields.io/badge/OpenClaw-Plugin-0f172a" alt="OpenClaw Plugin"></a>
    <a href="https://sparkengineai.github.io/QuantClaw/"><img src="https://img.shields.io/badge/Blog-Live-0ea5e9" alt="Blog"></a>
    <a href="https://arxiv.org/abs/2604.22577"><img src="https://img.shields.io/badge/Paper-arXiv-f97316" alt="Paper arXiv"></a>
    <img src="https://img.shields.io/badge/Routing-4bit%20%7C%208bit%20%7C%2016bit-2563eb" alt="Routing tiers">
    <img src="https://img.shields.io/badge/License-MIT-16a34a" alt="MIT License">
  </p>
</div>

![QuantClaw overview](./figs/overview.png)

QuantClaw is a plug-and-play task-type routing quantization plugin for OpenClaw. It classifies each incoming request, maps it to a precision tier (`4bit`, `8bit`, or `16bit`), and routes the request to the right model target so you can balance quality, latency, and cost without asking users to choose precision manually.

## 🔍 About QuantClaw

QuantClaw is built from quantization studies on OpenClaw workloads rather than from fixed intuition. We evaluate quantized and high-precision models across 24 task types, 104 tasks, 6 models, and scales from 9B to 744B.

Results on Claw-Eval (release v0.0.0):

<div align="center">

<table>
  <thead>
    <tr>
      <th align="left">Model</th>
      <th align="center">Params (B)</th>
      <th align="center">BF16 / FP8</th>
      <th align="center">NVFP4</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td><strong>GLM-4.7-Flash</strong></td>
      <td align="center">30</td>
      <td align="center">0.6370</td>
      <td align="center"><strong>0.6034</strong></td>
    </tr>
    <tr>
      <td><strong>GLM-5</strong></td>
      <td align="center">744</td>
      <td align="center">0.7130</td>
      <td align="center"><strong>0.7229</strong></td>
    </tr>
    <tr>
      <td><strong>MiniMax-M2.5</strong></td>
      <td align="center">229</td>
      <td align="center">0.6760</td>
      <td align="center"><strong>0.6823</strong></td>
    </tr>
    <tr>
      <td><strong>Qwen3.5-9B</strong></td>
      <td align="center">9</td>
      <td align="center">0.4267</td>
      <td align="center"><strong>0.4107</strong></td>
    </tr>
    <tr>
      <td><strong>Qwen3.5-35B-A3B</strong></td>
      <td align="center">35</td>
      <td align="center">0.6686</td>
      <td align="center"><strong>0.6549</strong></td>
    </tr>
    <tr>
      <td><strong>Qwen3.5-397B-A17B</strong></td>
      <td align="center">397</td>
      <td align="center">0.7048</td>
      <td align="center"><strong>0.6937</strong></td>
    </tr>
  </tbody>
</table>

</div>

- High-sensitivity tasks such as coding, safety, and complex workflows benefit from higher precision.
- Low-sensitivity tasks such as research, multimodal understanding, comprehension, knowledge lookup, office QA, and data analysis can often run well on lower precision.

<p align="center">
  <img src="./figs/sensitivity_chart.png" alt="sensitivity chart" width="600">
</p>

## ✨ Key Features

<table align="center">
  <tr align="center">
    <th><p align="center"> Automatic Adaptation</p></th>
    <th><p align="center"> Intelligent Routing</p></th>
    <th><p align="center"> Full Customizability</p></th>
    <th><p align="center"> Built-in Observability</p></th>
  </tr>
  <tr>
    <td align="center"><p align="center"><img src="figs/ruleDetector.png" width="400" height="250"></p></td>
    <td align="center"><p align="center"><img src="figs/session.png" width="400" height="250"></p></td>
    <td align="center"><p align="center"><img src="figs/config.png" width="400" height="250"></p></td>
    <td align="center"><p align="center"><img src="figs/dashboard.png" width="400" height="250"></p></td>
  </tr>
  <tr>
    <td align="center">Rules first, then a judge model for requests.</td>
    <td align="center">Map each query to 4bit, 8bit, or 16bit targets.</td>
    <td align="center">Tune task types, patterns, targets, pricing, and backends.</td>
    <td align="center">Track routing, tokens, cost, sessions, and live config changes.</td>
  </tr>
</table>

## 🚀 Quick Start

**Install**

```bash
# Prerequisite: OpenClaw is already installed.

# Install from Clawhub (recommended)
openclaw plugins install clawhub:@sparkengineai/quantclaw

# If OpenClaw is running from a source checkout and the CLI is not on PATH:
cd /path/to/openclaw
node openclaw.mjs plugins install @sparkengineai/quantclaw

# Or install from source
git clone https://github.com/SparkEngineAI/QuantClaw-plugin.git ./quantclaw
openclaw plugins install ./quantclaw

# If the OpenClaw CLI is not on PATH:
cd /path/to/openclaw
node openclaw.mjs plugins install /path/to/quantclaw
```

**Create or bootstrap the runtime config**

QuantClaw reads its runtime config from:

```text
~/.openclaw/quantclaw.json
```

If the file does not exist, starting OpenClaw with the plugin enabled will generate a default `quantclaw.json`. If you are working from this repository directly, you can also start from the provided example:

```bash
cp config.example.json ~/.openclaw/quantclaw.json
```

**Edit the detector chain and targets**

```json
{
  "quant": {
    "enabled": true,
    "detectors": ["ruleDetector", "loadModelDetector"],
    "judge": {
      "endpoint": "http://127.0.0.1:8000",
      "model": "BAAI/bge-m3",
      "providerType": "openai-compatible",
      "apiKey": "",
      "cacheTtlMs": 300000
    }
  }
}
```

**Start OpenClaw and open the dashboard**

```text
http://127.0.0.1:18789/plugins/quantclaw/stats
```


## ⚙️ Configuration Notes

The runtime schema supports:

- ordered detectors: `ruleDetector`, `loadModelDetector`
- per-task-type `id`, `description`, `precision`, `keywords`, and `patterns`
- per-tier model targets with independent provider, model, endpoint, api key, and pricing
- model-level pricing overrides for cost reporting
- hot reload when `~/.openclaw/quantclaw.json` changes

Example `taskTypes` config:

```json
{
  "taskTypes": [
    {
      "id": "coding",
      "precision": "16bit",
      "description": "code review, bug analysis, implementation, debugging, kernels, async behavior, web development",
      "keywords": ["code", "debug", "bug", "Python", "CUDA", "编程", "代码"],
      "patterns": [
        "fix the bug in this repository",
        "(?=.*(?:refactor|重构))(?=.*(?:typescript|ts|node)).*"
      ]
    }
  ],
  "defaultTaskType": "standard"
}
```

Example `targets` config:

```json
{
  "targets": {
    "4bit": {
      "provider": "quantclaw-4bit",
      "model": "glm-4.7-flash-int4-autoround",
      "endpoint": "https://api.example.com/v1",
      "apiKey": "${QC_4BIT_API_KEY}",
      "displayName": "4-bit Target",
      "pricing": {
        "inputPer1M": 0.051,
        "outputPer1M": 0.34
      }
    },
    "16bit": {
      "provider": "quantclaw-16bit",
      "model": "glm-4.7-flash",
      "endpoint": "https://api.openai.com/v1",
      "apiKey": "${QC_16BIT_API_KEY}",
      "displayName": "16-bit Target",
      "pricing": {
        "inputPer1M": 0.06,
        "outputPer1M": 0.4
      }
    }
  }
}
```

Example `modelPricing` overrides:

```json
{
  "modelPricing": {
    "glm-4.7-flash": {
      "inputPer1M": 0.06,
      "outputPer1M": 0.4
    },
    "glm-4.7-flash-int4-autoround": {
      "inputPer1M": 0.051,
      "outputPer1M": 0.34
    }
  }
}
```

Target-level `pricing` is used first for that precision tier. If it is absent, QuantClaw falls back to `modelPricing` for cost reporting.

## 🧠 `loadModelDetector` Backends

`loadModelDetector` supports either a local embedding-based router exposed through an OpenAI-compatible API or a regular OpenAI-compatible LLM judge.

Build a local embedding router index:

```bash
python router/embedding_task_router.py --model-name BAAI/bge-m3 --device cuda --config-path ~/.openclaw/quantclaw.json --output-dir ./embedding_router_index-bge-m3 build --print-summary
```

Serve that router as an OpenAI-compatible endpoint:

```bash
python router/embedding_task_router_server.py --model-name BAAI/bge-m3 --device cuda --output-dir ./embedding_router_index-bge-m3 --port 8012
```

If your machine does not have a GPU, change `--device cuda` to `--device cpu`.

If you do not want to run the local embedding router, you can point `quant.judge.endpoint` at any OpenAI-compatible LLM endpoint instead.

## 🙏 Acknowledgements

We especially acknowledge:

- [Claw-Eval](https://github.com/claw-eval/claw-eval)
- [PinchBench](https://github.com/pinchbench/skill)
- [WildClawBench](https://github.com/InternLM/WildClawBench)
- [ClawXRouter](https://github.com/OpenBMB/ClawXRouter/tree/main)

## 👥 Core Contributors
[Manyi Zhang](https://openreview.net/profile?id=%7EManyi_Zhang2), [Ji-Fu Li*](https://openreview.net/profile?id=~Ji-Fu_Li1), [Zhongao Sun](https://openreview.net/profile?id=~Zhongao_Sun1), [Xiaohao Liu](https://xiaohao-liu.github.io), [Zhenhua Dong](https://scholar.google.com/citations?user=JeePtHEAAAAJ&hl=en), [Xianzhi Yu](https://scholar.google.com/citations?user=tGnJRYQAAAAJ&hl=en), [Haoli Bai](https://haolibai.github.io/) (Project Lead), [Xiaobo Xia](https://xiaoboxia.github.io/)

*Follow SparkEngineAI on WeChat. We hope to share cutting-edge progress in AI Infra, light up stars in the AI field, and help everyone learn and draw inspiration.*

<p align="left">
  <img src="./figs/SparkEngineAI.jpg" alt="SparkEngineAI official account" width="240">
</p>

## 📖 Citation

If QuantClaw helps your research, engineering work, or benchmark studies, please cite:

```bibtex
@article{zhang2026quantclaw,
  title={QuantClaw: Precision Where It Matters for OpenClaw},
  author={Zhang, Manyi and Li, Ji-Fu and Sun, Zhongao and Liu, Xiaohao and Dong, Zhenghua and Yu, Xianzhi and Bai, Haoli and Xia, Xiaobo},
  journal={arXiv preprint arXiv:2604.22577},
  year={2026}
}
```
