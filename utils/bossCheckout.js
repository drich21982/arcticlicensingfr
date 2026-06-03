const fs = require('fs');
const path = require('path');

/**
 * Create a Stripe Checkout Session
 * @param {Object} params
 * @param {string} [params.product] - Product name (single-item fallback)
 * @param {number} [params.price] - Price in USD (single-item fallback)
 * @param {string} [params.image] - Product image URL (optional, single-item fallback)
 * @param {Array<Object>} [params.items] - Multi-item checkout payload
 * @param {Object} [params.metadata] - Metadata (optional)
 * @param {string} [params.cancelUrl] - Optional cancel URL
 * @returns {Promise<{ sessionUrl: string, sessionId: string }>}
 */
async function createStripeCheckoutSession({ product, price, image, items, metadata, cancelUrl }) {
    const stripeKey = process.env.STRIPE_KEY;
    if (!stripeKey) throw new Error('STRIPE_KEY not set in environment variables');

    const stripe = require('stripe')(stripeKey);

    try {
        const normalizedItems = Array.isArray(items) && items.length > 0
            ? items
                .map((item) => {
                    if (!item || typeof item !== 'object') return null;
                    const itemName = String(item.product || item.name || '').trim();
                    const itemImage = String(item.image || '').trim();
                    const itemPrice = Number(item.price);
                    const itemProductKey = String(item.productKey || item.key || '').trim();
                    const itemProductType = String(item.productType || item.type || '').trim();
                    const itemSelectedVariant = String(item.selectedVariant || '').trim();

                    if (!itemName || !Number.isFinite(itemPrice)) return null;

                    return {
                        name: itemName,
                        image: itemImage,
                        price: itemPrice,
                        productKey: itemProductKey,
                        productType: itemProductType,
                        selectedVariant: itemSelectedVariant
                    };
                })
                .filter(Boolean)
            : [];

        if (normalizedItems.length === 0) {
            const fallbackName = String(product || '').trim();
            const fallbackPrice = Number(price);
            if (!fallbackName || !Number.isFinite(fallbackPrice)) {
                throw new Error('Invalid checkout request payload');
            }
            normalizedItems.push({
                name: fallbackName,
                image: String(image || '').trim(),
                price: fallbackPrice,
                productKey: String(metadata && metadata.productKey || '').trim(),
                productType: String(metadata && metadata.productType || '').trim(),
                selectedVariant: String(metadata && metadata.selectedVariant || '').trim()
            });
        }

        const lineItems = [];
        for (const item of normalizedItems) {
            const productData = await stripe.products.create({
                name: item.name,
                description: item.name,
                images: item.image ? [item.image] : [],
                metadata: {
                    productKey: item.productKey,
                    productType: item.productType,
                    selectedVariant: item.selectedVariant,
                    productName: item.name
                }
            });

            const priceData = await stripe.prices.create({
                product: productData.id,
                unit_amount: Math.round(item.price * 100),
                currency: 'usd'
            });

            lineItems.push({
                price: priceData.id,
                quantity: 1
            });
        }

        const primaryItem = normalizedItems[0];

        // Build success params
        const successParams = new URLSearchParams();
        successParams.set('product', String(primaryItem.name || ''));
        successParams.set('image', String(primaryItem.image || ''));

        if (metadata && metadata.cartCheckout === 'true') {
            successParams.set('cartCheckout', '1');
        }

        if (metadata?.productKey) {
            successParams.set('productKey', String(metadata.productKey));
        }
        if (metadata?.productType) {
            successParams.set('productType', String(metadata.productType));
        }
        if (metadata?.selectedVariant) {
            successParams.set('variant', String(metadata.selectedVariant));
        }

        const successParamString = successParams.toString();
        const successUrl = `${process.env.DOMAIN}/complete?${successParamString}${successParamString ? '&' : ''}checkoutSessionId={CHECKOUT_SESSION_ID}`;

        // Create Checkout Session
        const session = await stripe.checkout.sessions.create({
            mode: 'payment',

            // ✅ IMPORTANT: Do NOT include payment_method_types
            // Stripe will automatically use all enabled methods from dashboard

            line_items: [
                ...lineItems
            ],

            success_url: successUrl,
            cancel_url: `${process.env.DOMAIN}${cancelUrl || `/package/vehicle.html?vehicle=${encodeURIComponent(primaryItem.name)}`}`,

            metadata: metadata || {},
        });

        return {
            sessionUrl: session.url,
            sessionId: session.id,
        };

    } catch (error) {
        console.error('Error creating checkout session:', error);
        throw error;
    }
}

module.exports = {
    createStripeCheckoutSession,
};
