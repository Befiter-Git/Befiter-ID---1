import { parsePhoneNumber } from "libphonenumber-js";

export function normalisePhone(phone: string): string {
  if (phone.length > 30) {
    throw new Error("Phone number is too long");
  }

  const cleaned = phone.trim().replace(/[\s\-().]/g, "");

  if (!cleaned) {
    throw new Error("Phone number cannot be empty");
  }

  if (cleaned.startsWith("+")) {
    try {
      const parsed = parsePhoneNumber(cleaned);
      if (parsed && parsed.isValid()) {
        return parsed.format("E.164");
      }
    } catch {
    }
    throw new Error("Invalid international phone number");
  }

  let withoutLeadingZero = cleaned;
  if (cleaned.startsWith("0")) {
    withoutLeadingZero = cleaned.slice(1);
  }

  const withCountryCode = "+91" + withoutLeadingZero;
  try {
    const parsed = parsePhoneNumber(withCountryCode);
    if (parsed && parsed.isValid()) {
      return parsed.format("E.164");
    }
  } catch {
  }

  throw new Error("Invalid phone number");
}
