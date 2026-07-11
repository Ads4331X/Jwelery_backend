const prisma = require("../config/prisma");
const transporter = require("./transporter");

function formatItemsForText(order) {
  if (!order?.items || !Array.isArray(order.items)) return "";

  return order.items
    .map((it) => {
      const name = it.productName || it.productId || "Item";
      const qty = it.quantity ?? 0;
      const unit = it.unitPrice ?? 0;
      const lineTotal = it.totalPrice ?? unit * qty;
      return `- ${name} (Qty: ${qty}) @ ${unit} | Total: ${lineTotal}`;
    })
    .join("\n");
}

async function resolveStoreEmail() {
  try {
    const setting = await prisma.siteSetting.findUnique({
      where: { key: "store_email" },
      select: { value: true },
    });

    const value = (setting?.value ?? "").trim();
    if (value) return value;
  } catch (e) {
    // fall through to env fallback
    console.error("resolveStoreEmail error:", e);
  }

  return (process.env.SMTP_USER || "").trim();
}

async function sendOrderConfirmationEmail(order, customer) {
  try {
    const to = customer?.email;
    if (!to) return;

    const subject = `Order Confirmed — ${order.orderNumber}`;
    const body =
      `Hello${customer?.firstName ? " " + customer.firstName : ""},\n\n` +
      `Thanks for your order! Your order has been confirmed.\n\n` +
      `Order Number: ${order.orderNumber}\n\n` +
      `Items:\n${formatItemsForText(order) || "-"}\n\n` +
      `Total: ${order.totalAmount}\n\n` +
      `Status: Pending\n\n` +
      `Regards,\nAnand Jewellers`;

    await transporter.sendMail({
      from: process.env.SMTP_USER,
      to,
      subject,
      text: body,
    });
  } catch (err) {
    console.error("sendOrderConfirmationEmail failed:", err);
  }
}

async function sendAdminNewOrderEmail(order, customer) {
  try {
    const adminEmail = await resolveStoreEmail();
    if (!adminEmail) return;

    const subject = `New Order — ${order.orderNumber}`;

    const customerName = customer?.firstName
      ? customer.firstName
      : customer?.username || "";

    const body =
      `Hello Admin,\n\n` +
      `A new order has been placed.\n\n` +
      `Order Number: ${order.orderNumber}\n\n` +
      `Customer Details:\n` +
      `- Name: ${customerName || ""}\n` +
      `- Email: ${customer?.email || ""}\n` +
      `- Phone: ${customer?.phone || ""}\n\n` +
      `Items:\n${formatItemsForText(order) || "-"}\n\n` +
      `Total: ${order.totalAmount}\n\n` +
      `Payment Method: COD\n\n` +
      `Regards,\nAnand Jewellers`;

    await transporter.sendMail({
      from: process.env.SMTP_USER,
      to: adminEmail,
      subject,
      text: body,
    });
  } catch (err) {
    console.error("sendAdminNewOrderEmail failed:", err);
  }
}

async function sendOrderStatusUpdateEmail(order, customer, newStatus) {
  try {
    const to = customer?.email;
    if (!to) return;

    const subject = `Order ${order.orderNumber} — ${newStatus}`;

    const body =
      `Hello${customer?.firstName ? " " + customer.firstName : ""},\n\n` +
      `Your order status has been updated.\n\n` +
      `Order Number: ${order.orderNumber}\n` +
      `New Status: ${newStatus}\n\n` +
      `Regards,\nAnand Jewellers`;

    await transporter.sendMail({
      from: process.env.SMTP_USER,
      to,
      subject,
      text: body,
    });
  } catch (err) {
    console.error("sendOrderStatusUpdateEmail failed:", err);
  }
}

module.exports = {
  sendOrderConfirmationEmail,
  sendAdminNewOrderEmail,
  sendOrderStatusUpdateEmail,
};
