import { prisma } from "../config/prisma.js";
import { DeviceCondition } from "@prisma/client";
import { ChatOpenAI } from "@langchain/openai";

interface ValuationRequest {
  brand: string;
  model: string;
  condition: DeviceCondition;
  batteryHealth: number;
  marketTrend?: string; // "UP", "DOWN", "STABLE"
}

interface ValuationResponse {
  estimatedResaleValue: number;
  tradeInRecommendation: number;
  conditionPricingLogic: string;
  reasoning: string;
}

interface FinancingRequest {
  monthlyIncome: number;
  existingDebts: number;
  requestedAmount: number;
  creditScore?: number;
  employmentStatus: string;
}

interface FinancingResponse {
  riskSummary: string;
  paymentAbilityEstimate: string;
  installmentRecommendation: string;
  fraudFlagHints: string[];
  paymentAbilityScore: number; // 0 to 100
}

interface RepairRequest {
  brand: string;
  model: string;
  symptoms: string;
}

interface RepairResponse {
  commonFaultDiagnosis: string;
  suggestedSteps: string[];
  checklist: string[];
  recommendedParts: string[];
}

interface ResellPricingRequest {
  brand: string;
  model: string;
  originalCondition: DeviceCondition;
  postRepairCondition?: DeviceCondition;
  batteryHealth: number;
  acquisitionCost: number;
  repairCost?: number;
  originalAiEstimate?: number;
  preOfferInspection?: string;
  repairNotes?: string;
  defects?: string;
}

interface ResellPricingResponse {
  suggestedListPrice: number;
  suggestedPromotionPercent: number | null;
  marginPercent: number;
  conditionComparison: string;
  reasoning: string;
}

type LlmProvider = "groq" | "openai";

export class AiService {
  private static getLlmConfig(): { apiKey: string; model: string; provider: LlmProvider; baseURL?: string } | null {
    const groqKey = process.env["GROQ_API_KEY"];
    if (groqKey) {
      return {
        apiKey: groqKey,
        model: process.env["GROQ_MODEL"] || "llama-3.3-70b-versatile",
        provider: "groq",
        baseURL: "https://api.groq.com/openai/v1",
      };
    }

    const openaiKey = process.env["OPENAI_API_KEY"];
    if (openaiKey) {
      return {
        apiKey: openaiKey,
        model: process.env["OPENAI_MODEL"] || "gpt-4o-mini",
        provider: "openai",
      };
    }

    return null;
  }

  static isLlmConfigured(): boolean {
    return this.getLlmConfig() !== null;
  }

  private static async callLlm<T>(systemPrompt: string, userPrompt: string, fallback: T): Promise<T> {
    const config = this.getLlmConfig();
    if (!config) {
      return fallback;
    }

    try {
      const model = new ChatOpenAI({
        apiKey: config.apiKey,
        model: config.model,
        temperature: 0,
        maxRetries: 2,
        ...(config.baseURL
          ? { configuration: { baseURL: config.baseURL } }
          : {}),
        modelKwargs: {
          response_format: { type: "json_object" },
        },
      });
      const response = await model.invoke([
        ["system", `${systemPrompt} Return your response ONLY as a raw JSON object matching the requested schema.`],
        ["human", userPrompt],
      ]);
      const content = typeof response.content === "string" ? response.content : null;
      if (content) {
        return JSON.parse(content) as T;
      }
      return fallback;
    } catch (error) {
      console.error(`Error communicating with ${config.provider}:`, error);
      return fallback;
    }
  }

  private static async callLlmText(systemPrompt: string, userPrompt: string, fallback: string): Promise<string> {
    const config = this.getLlmConfig();
    if (!config) {
      return fallback;
    }

    try {
      const model = new ChatOpenAI({
        apiKey: config.apiKey,
        model: config.model,
        temperature: 0.3,
        maxRetries: 2,
        ...(config.baseURL
          ? { configuration: { baseURL: config.baseURL } }
          : {}),
      });
      const response = await model.invoke([
        ["system", systemPrompt],
        ["human", userPrompt],
      ]);
      const content = typeof response.content === "string" ? response.content.trim() : "";
      return content || fallback;
    } catch (error) {
      console.error(`Error communicating with ${config.provider}:`, error);
      return fallback;
    }
  }

  /**
   * 1. AI Device Valuation Assistant
   */
  static async evaluateDevice(req: ValuationRequest): Promise<ValuationResponse> {
    const basePrices: Record<string, number> = {
      iphone: 600,
      samsung: 500,
      ipad: 400,
      macbook: 1000,
      pixel: 450,
    };

    const brandLower = req.brand.toLowerCase();
    let base = 300; // Default
    for (const key in basePrices) {
      if (brandLower.includes(key)) {
        base = basePrices[key] ?? 300;
        break;
      }
    }

    // Condition Multipliers
    const multipliers: Record<DeviceCondition, number> = {
      NEW: 1.0,
      EXCELLENT: 0.85,
      GOOD: 0.70,
      FAIR: 0.50,
      POOR: 0.30,
    };
    const condMult = multipliers[req.condition] || 0.70;

    // Battery Multiplier
    const batMult = req.batteryHealth >= 90 ? 1.0 : req.batteryHealth >= 80 ? 0.92 : 0.80;

    // Valuation Logic
    const resaleValue = Math.round(base * condMult * batMult);
    const tradeInValue = Math.round(resaleValue * 0.80);

    const systemPrompt = `You are an AI Device Valuation Assistant. Estimate the resale and trade-in value of secondhand electronic devices.`;
    const userPrompt = `Brand: ${req.brand}, Model: ${req.model}, Condition: ${req.condition}, Battery Health: ${req.batteryHealth}%.
    Format: JSON object with keys:
    estimatedResaleValue (number), tradeInRecommendation (number), conditionPricingLogic (string), reasoning (string).`;

    const fallbackResponse: ValuationResponse = {
      estimatedResaleValue: resaleValue,
      tradeInRecommendation: tradeInValue,
      conditionPricingLogic: `Base price for ${req.brand} is offset by condition rating ${req.condition} (${condMult * 100}%) and battery health of ${req.batteryHealth}% (${batMult * 100}%).`,
      reasoning: `Market data for ${req.brand} ${req.model} shows strong stability. The condition '${req.condition}' justifies a resale price of $${resaleValue}. We recommend offering a trade-in value of $${tradeInValue} to retain margins for servicing and quality assurance certification.`
    };

    return this.callLlm<ValuationResponse>(systemPrompt, userPrompt, fallbackResponse);
  }

  /**
   * 2. AI Financing Assistant
   */
  static async evaluateFinancing(req: FinancingRequest): Promise<FinancingResponse> {
    const monthlyIncome = req.monthlyIncome;
    const debts = req.existingDebts;
    const requested = req.requestedAmount;
    const creditScore = req.creditScore || 650;

    const netDisposable = monthlyIncome - debts;
    const installment12m = (requested * 1.12) / 12; // 12% interest markup

    // Calculate a payment ability score (0 - 100)
    let score = 50;
    if (netDisposable > installment12m * 4) score += 20;
    else if (netDisposable > installment12m * 2) score += 10;
    else score -= 20;

    if (creditScore >= 750) score += 20;
    else if (creditScore >= 650) score += 10;
    else score -= 15;

    if (req.employmentStatus.toLowerCase() === "employed") score += 10;

    score = Math.max(10, Math.min(100, score));

    const fraudFlags: string[] = [];
    if (debts > monthlyIncome * 0.8) {
      fraudFlags.push("High Debt-to-Income Ratio (DTI > 80%)");
    }
    if (requested > monthlyIncome * 3) {
      fraudFlags.push("Over-leverage Request: Requested device amount exceeds 3x monthly income");
    }
    if (creditScore < 500) {
      fraudFlags.push("Critical Credit History Flag");
    }

    const approved = score >= 50 ? "APPROVED" : "REJECTED";

    const systemPrompt = `You are an AI Financing Assistant. Evaluate financing applications, estimate repayment risks, detect potential fraud flags, and recommend installment approvals.`;
    const userPrompt = `Monthly Income: ${monthlyIncome}, Debts: ${debts}, Requested Amount: ${requested}, Credit Score: ${creditScore}, Employment Status: ${req.employmentStatus}.
    Format: JSON object with keys:
    riskSummary (string), paymentAbilityEstimate (string), installmentRecommendation (string), fraudFlagHints (string array), paymentAbilityScore (number 0-100).`;

    const fallbackResponse: FinancingResponse = {
      riskSummary: score >= 50
        ? `Low-to-medium risk. The applicant's disposable income is $${netDisposable}, which provides sufficient buffer to cover the monthly installment of $${Math.round(installment12m)}.`
        : `High repayment risk. Disposable income is too low ($${netDisposable}) relative to expenses and requested device value.`,
      paymentAbilityEstimate: `Applicant demonstrates a ${score >= 50 ? "strong" : "weak"} capability to service this debt. DTI stands at ${Math.round((debts / monthlyIncome) * 100)}%.`,
      installmentRecommendation: score >= 50
        ? `We recommend approving the application with a 12-month tenure at $${Math.round(installment12m)}/month.`
        : `Decline. Alternatively, offer a lower value device (max budget $${Math.round(netDisposable * 0.25 * 12)}) or require a co-signer.`,
      fraudFlagHints: fraudFlags,
      paymentAbilityScore: score
    };

    return this.callLlm<FinancingResponse>(systemPrompt, userPrompt, fallbackResponse);
  }

  /**
   * 3. AI Repair Guidance Assistant
   */
  static async getRepairGuidance(req: RepairRequest): Promise<RepairResponse> {
    const sym = req.symptoms.toLowerCase();
    let fault = "General Hardware Failure";
    let steps: string[] = ["Inspect device for physical damage", "Perform power cycle", "Run hardware diagnostics"];
    let checklist: string[] = ["Device powers on", "Screen functional", "Buttons responsive"];
    let parts: string[] = ["Universal repair kit"];

    if (sym.includes("screen") || sym.includes("display") || sym.includes("cracked")) {
      fault = "Damaged LCD/Digitizer Assembly";
      steps = [
        "Power off device and heat edges of screen frame to loosen adhesive",
        "Use suction cup and pry tools to carefully separate screen from chassis",
        "Disconnect battery flex cable followed by screen digitizer cables",
        "Clean adhesive residue from chassis frame",
        "Connect new screen assembly for testing before gluing",
        "Apply specialized LCD adhesive tape and press-fit the display",
        "Clamp display frame for 30 minutes to set adhesive"
      ];
      checklist = [
        "Touch screen responsiveness tested on all areas",
        "Display brightness and backlight uniform, no dead pixels",
        "Ambient light sensor and front camera aligned and working"
      ];
      parts = ["Replacement LCD Screen Assembly", "T7000 Adhesive Glue", "Display Adhesive Tape Strips"];
    } else if (sym.includes("battery") || sym.includes("charge") || sym.includes("drain") || sym.includes("power")) {
      fault = "Degraded Battery Cell / Power IC Failure";
      steps = [
        "Unscrew chassis security fasteners (pentalobe/torx)",
        "Isolate motherboard power connections first",
        "Apply adhesive remover or gentle heat behind battery pack (avoid direct puncture)",
        "Use non-conductive pry tool to lift battery out",
        "Clean battery well of old residue",
        "Apply battery adhesive and secure new OEM replacement cell",
        "Reconnect battery connector and test charging throughput"
      ];
      checklist = [
        "Fast-charging protocols validated (9V/12V check)",
        "Battery health cycle count reset and reporting 100%",
        "Thermal readings stable during 15-minute load test"
      ];
      parts = ["OEM Replacement Li-ion Battery", "Battery Adhesive Pull Tabs", "Charging Port Flex (optional evaluation)"];
    }

    const systemPrompt = `You are an AI Repair Guidance Assistant for electronic devices. Generate diagnosis and repair procedures.`;
    const userPrompt = `Device: ${req.brand} ${req.model}, Symptom: ${req.symptoms}.
    Format: JSON object with keys:
    commonFaultDiagnosis (string), suggestedSteps (string array), checklist (string array), recommendedParts (string array).`;

    const fallbackResponse: RepairResponse = {
      commonFaultDiagnosis: fault,
      suggestedSteps: steps,
      checklist: checklist,
      recommendedParts: parts
    };

    return this.callLlm<RepairResponse>(systemPrompt, userPrompt, fallbackResponse);
  }

  /**
   * 4. AI Post-Repair Resell Pricing
   */
  static async suggestResellPrice(req: ResellPricingRequest): Promise<ResellPricingResponse> {
    const postCondition = req.postRepairCondition || req.originalCondition;
    const multipliers: Record<DeviceCondition, number> = {
      NEW: 1.0,
      EXCELLENT: 0.88,
      GOOD: 0.74,
      FAIR: 0.55,
      POOR: 0.35,
    };
    const origMult = multipliers[req.originalCondition] || 0.7;
    const postMult = multipliers[postCondition] || 0.7;
    const batMult = req.batteryHealth >= 90 ? 1.0 : req.batteryHealth >= 80 ? 0.94 : 0.86;
    const repairCost = req.repairCost ?? 0;
    const baseResale = (req.originalAiEstimate || req.acquisitionCost * 1.45) * (postMult / origMult) * batMult;
    const minViable = req.acquisitionCost + repairCost + 40;
    const suggested = Math.round(Math.max(minViable, baseResale));
    const margin = suggested > 0 ? Math.round(((suggested - req.acquisitionCost - repairCost) / suggested) * 100) : 0;

    const systemPrompt =
      "You are an AI pricing assistant for a refurbished electronics marketplace. Suggest resale list prices based on device condition before and after repair, inspection notes, and acquisition costs.";
    const userPrompt = `Brand: ${req.brand}, Model: ${req.model}
Original condition: ${req.originalCondition}
Post-repair condition: ${postCondition}
Battery health: ${req.batteryHealth}%
Acquisition cost: $${req.acquisitionCost}
Repair cost: $${repairCost}
Original AI estimate: ${req.originalAiEstimate ?? "unknown"}
Pre-offer inspection: ${req.preOfferInspection || "none"}
Repair completion notes: ${req.repairNotes || "none"}
Reported defects: ${req.defects || "none"}
Format: JSON with keys suggestedListPrice (number), suggestedPromotionPercent (number or null), marginPercent (number), conditionComparison (string), reasoning (string).`;

    const fallbackResponse: ResellPricingResponse = {
      suggestedListPrice: suggested,
      suggestedPromotionPercent: margin > 30 ? 5 : null,
      marginPercent: margin,
      conditionComparison: `Condition moved from ${req.originalCondition} to ${postCondition} after refurbishment.`,
      reasoning: `Based on acquisition cost ($${req.acquisitionCost}), repair spend ($${repairCost}), and improved condition (${postCondition}), a list price of $${suggested} balances competitiveness with a ${margin}% margin. ${req.repairNotes ? `Repair notes: ${req.repairNotes.slice(0, 120)}.` : ""}`,
    };

    return this.callLlm<ResellPricingResponse>(systemPrompt, userPrompt, fallbackResponse);
  }

  /**
   * 5. AI Customer Support Chat
   */
  static async handleSupportChat(sessionId: string, message: string): Promise<string> {
    // 1. Log user message
    await prisma.supportChatMessage.create({
      data: {
        sessionId,
        sender: "USER",
        content: message,
      }
    });

    const msgLower = message.toLowerCase();

    // 2. Fetch inventory or details to personalize support if possible
    let answer = "";
    if (msgLower.includes("recommend") || msgLower.includes("buy") || msgLower.includes("device") || msgLower.includes("phone")) {
      const devices = await prisma.device.findMany({
        where: { status: "READY" },
        take: 3
      });

      if (devices.length > 0) {
        answer = "Here are a few top-quality, certified refurbished devices currently available in our marketplace:\n" +
          devices.map(d => `- **${d.brand} ${d.model}** (${d.condition} Condition) - $${d.price} (Trust Score: ${d.trustScore}/100)`).join("\n") +
          "\nAll devices include a Device Digital Passport detailing battery status and repair history. We also offer interest-free installment options at checkout!";
      } else {
        answer = "I'd love to help you find a device. We currently have no devices fully certified in our inventory right now, but check back shortly! What brand (e.g. iPhone, Samsung) are you interested in?";
      }
    } else if (msgLower.includes("financing") || msgLower.includes("installment") || msgLower.includes("pay")) {
      answer = "Our financing system allows you to split the cost of any device into monthly installments (e.g. 6, 12, or 24 months) instead of paying upfront. To apply:\n1. Add a device to your cart.\n2. Choose 'Apply for Financing' during checkout.\n3. Fill in your details (income, employment) and get an instant AI risk analysis.\n4. Once a Finance Officer approves, your order is dispatched!";
    } else if (msgLower.includes("trade-in") || msgLower.includes("exchange") || msgLower.includes("sell")) {
      answer = "Yes! You can trade in your old device. Simply go to the 'Trade-In' section, specify your device details (brand, model, and physical wear condition), and our AI valuation engine will provide an instant estimate. Once verified at our service center, you'll receive checkout credits or cash.";
    } else if (msgLower.includes("track") || msgLower.includes("order") || msgLower.includes("status")) {
      // Find user orders if session exists
      const session = await prisma.supportChatSession.findUnique({
        where: { id: sessionId },
        include: { customer: true }
      });
      if (session?.customerId) {
        const lastOrder = await prisma.order.findFirst({
          where: { customerId: session.customerId },
          orderBy: { createdAt: "desc" }
        });
        if (lastOrder) {
          answer = `Your most recent order is **Order #${lastOrder.id.slice(0, 8)}** placed on ${lastOrder.createdAt.toLocaleDateString()}. The current status is: **${lastOrder.status}**.`;
        } else {
          answer = "I couldn't find any orders linked to your profile. If you have an order number, please share it and I can help track it!";
        }
      } else {
        answer = "I can track your order! Please login to your customer account, or provide your order ID, and I will search the status for you.";
      }
    } else {
      answer = "Hello! I am your AI Support Assistant for the Secondhand Device Refurbishment & Financing Platform. I can recommend refurbished devices, explain installment financing terms, help you calculate a trade-in value, or check order tracking status. How can I help you today?";
    }

    const systemPrompt = `You are a conversational Customer Support AI for a refurbished device resale and installment financing web application. Answer user queries concisely and supportively.`;
    const userPrompt = `User message: ${message}\nSuggested baseline answer: ${answer}`;

    const finalAnswer = await this.callLlmText(systemPrompt, userPrompt, answer);

    // 3. Log AI response
    await prisma.supportChatMessage.create({
      data: {
        sessionId,
        sender: "AI",
        content: finalAnswer,
      }
    });

    return finalAnswer;
  }
}
