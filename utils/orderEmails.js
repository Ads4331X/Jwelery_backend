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

async function formatItemsForHtml(order) {
  if (!order?.items || !Array.isArray(order.items)) return "";

  let html = `<table style="width:100%; border-collapse:collapse; margin-top:10px; margin-bottom:10px;">`;
  html += `<thead><tr><th style="text-align:left; padding:5px; border-bottom:1px solid #ddd;">Image</th><th style="text-align:left; padding:5px; border-bottom:1px solid #ddd;">Product</th><th style="text-align:left; padding:5px; border-bottom:1px solid #ddd;">Qty</th><th style="text-align:left; padding:5px; border-bottom:1px solid #ddd;">Unit Price</th><th style="text-align:left; padding:5px; border-bottom:1px solid #ddd;">Total</th></tr></thead><tbody>`;

  for (const it of order.items) {
    const name = it.productName || it.productId || "Item";
    const qty = it.quantity ?? 0;
    const unit = it.unitPrice ?? 0;
    const lineTotal = it.totalPrice ?? unit * qty;

    let imgHtml = "";
    if (it.productId) {
      try {
        let img = await prisma.productImage.findFirst({
          where: { productId: it.productId, isPrimary: true },
        });
        if (!img) {
          img = await prisma.productImage.findFirst({
            where: { productId: it.productId },
            orderBy: { sortOrder: "asc" },
          });
        }
        if (img && img.url) {
          imgHtml = `<img src="${img.url}" alt="${name}" style="width:60px;height:60px;object-fit:cover;" />`;
        }
      } catch (e) {
        console.error("Error fetching product image for email:", e);
      }
    }

    html += `<tr>`;
    html += `<td style="padding:5px; border-bottom:1px solid #eee;">${imgHtml}</td>`;
    html += `<td style="padding:5px; border-bottom:1px solid #eee;">${name}</td>`;
    html += `<td style="padding:5px; border-bottom:1px solid #eee;">${qty}</td>`;
    html += `<td style="padding:5px; border-bottom:1px solid #eee;">${unit}</td>`;
    html += `<td style="padding:5px; border-bottom:1px solid #eee;">${lineTotal}</td>`;
    html += `</tr>`;
  }

  html += `</tbody></table>`;
  return html;
}

async function sendOrderConfirmationEmail(order, customer) {
  try {
    const to = customer?.email;
    if (!to) return;

    const subject = `Order Confirmed — ${order.orderNumber}`;
    const textBody =
      `Hello${customer?.firstName ? " " + customer.firstName : ""},\n\n` +
      `Thanks for your order! Your order has been confirmed.\n\n` +
      `Order Number: ${order.orderNumber}\n\n` +
      `Items:\n${formatItemsForText(order) || "-"}\n\n` +
      `Total: ${order.totalAmount}\n\n` +
      `Status: Pending\n\n` +
      `Regards,\nAnand Jewellers`;

    const itemsHtml = await formatItemsForHtml(order);

    const htmlBody =
      `<p>Hello${customer?.firstName ? " " + customer.firstName : ""},</p>` +
      `<p>Thanks for your order! Your order has been confirmed.</p>` +
      `<p><b>Order Number:</b> ${order.orderNumber}</p>` +
      `<p><b>Items:</b></p>` +
      `${itemsHtml || "-"}` +
      `<p><b>Total:</b> ${order.totalAmount}</p>` +
      `<p><b>Status:</b> Pending</p>` +
      `<p>Regards,<br>Anand Jewellers</p>`;

    await transporter.sendMail({
      from: process.env.SMTP_USER,
      to,
      subject,
      text: textBody,
      html: htmlBody,
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

    const textBody =
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

    const itemsHtml = await formatItemsForHtml(order);

    const htmlBody =
      `<p>Hello Admin,</p>` +
      `<p>A new order has been placed.</p>` +
      `<p><b>Order Number:</b> ${order.orderNumber}</p>` +
      `<p><b>Customer Details:</b><br>` +
      `- Name: ${customerName || ""}<br>` +
      `- Email: ${customer?.email || ""}<br>` +
      `- Phone: ${customer?.phone || ""}</p>` +
      `<p><b>Items:</b></p>` +
      `${itemsHtml || "-"}` +
      `<p><b>Total:</b> ${order.totalAmount}</p>` +
      `<p><b>Payment Method:</b> COD</p>` +
      `<p>Regards,<br>Anand Jewellers</p>`;

    await transporter.sendMail({
      from: process.env.SMTP_USER,
      to: adminEmail,
      subject,
      text: textBody,
      html: htmlBody,
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

async function sendLowStockAlertEmail(product, { adminEditUrl } = {}) {
  try {
    const adminEmail = await resolveStoreEmail();
    if (!adminEmail) return;

    const subject = `Low Stock Alert — ${product?.name || "Product"}`;
    const currentStock = product?.stock ?? 0;

    // Best-effort reference to admin product edit page.
    // If your admin UI uses a different route, adjust this in the caller.
    const ref = adminEditUrl
      ? adminEditUrl
      : `https://example.com/admin/products/${product?.id || ""}`;

    const textBody =
      `Hello Admin,\n\n` +
      `Low stock alert for: ${product?.name || "Product"}\n` +
      `Current stock: ${currentStock}\n\n` +
      `Edit link: ${ref}\n\n` +
      `Regards,\nAnand Jewellers`;

    await transporter.sendMail({
      from: process.env.SMTP_USER,
      to: adminEmail,
      subject,
      text: textBody,
    });
  } catch (err) {
    console.error("sendLowStockAlertEmail failed:", err);
  }
}

module.exports = {
  // Re-export so other email utilities can reuse it without duplicating logic.
  resolveStoreEmail,
  sendOrderConfirmationEmail,
  sendAdminNewOrderEmail,
  sendOrderStatusUpdateEmail,
  sendLowStockAlertEmail,
};
