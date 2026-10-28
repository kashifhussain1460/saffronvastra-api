import { prisma } from "../../database/prisma.js";
import { generateUUID, hashToken } from "../../common/crypto.utils.js";
import { AuthenticatedRequest } from "../../common/auth.middleware.js";

export interface CartOwner {
  userId: string | null;
  guestProfileId: string | null;
  guestId?: string;
  isNewGuest?: boolean;
}

/**
 * Deterministically resolve cart owner (either authenticated user or guest profile)
 */
export async function resolveCartOwner(req: AuthenticatedRequest): Promise<CartOwner> {
  if (req.user?.id) {
    return {
      userId: req.user.id,
      guestProfileId: null,
    };
  }

  let guestId = req.guestId || (req.headers["x-guest-id"] as string) || req.cookies?.["saffron_guest_id"];

  if (guestId) {
    const hash = hashToken(guestId);
    let profile = await prisma.guestProfile.findUnique({
      where: { guestIdHash: hash },
    });

    if (!profile) {
      profile = await prisma.guestProfile.create({
        data: {
          guestIdHash: hash,
          consentState: { analytics: true, essential: true },
        },
      });
    }

    return {
      userId: null,
      guestProfileId: profile.id,
      guestId,
      isNewGuest: false,
    };
  }

  // Create new guest identity if neither user nor guest ID was provided
  const newGuestId = generateUUID();
  const hash = hashToken(newGuestId);
  const profile = await prisma.guestProfile.create({
    data: {
      guestIdHash: hash,
      consentState: { analytics: true, essential: true },
    },
  });

  return {
    userId: null,
    guestProfileId: profile.id,
    guestId: newGuestId,
    isNewGuest: true,
  };
}

/**
 * Format cart for client-facing response with computed pricing
 */
export function formatCartResponse(cart: any) {
  if (!cart) {
    return {
      id: null,
      currency: "INR",
      status: "ACTIVE",
      items: [],
      subtotalMinor: 0,
      totalItems: 0,
      createdAt: null,
      updatedAt: null,
    };
  }

  const items = (cart.items || []).map((item: any) => {
    const variant = item.variant;
    const product = variant?.product;
    const coverImage =
      product?.images?.find((img: any) => img.isCover)?.url ||
      product?.images?.[0]?.url ||
      "/images/brand/logo_emblem.png";

    // The cart shows the current catalogue price, which is also what checkout charges.
    const unitPriceMinor = variant?.priceOverrideMinor ?? product?.basePriceMinor ?? item.unitPriceSnapshotMinor;
    const lineTotalMinor = unitPriceMinor * item.quantity;

    return {
      id: item.id,
      cartId: item.cartId,
      variantId: item.variantId,
      quantity: item.quantity,
      unitPriceMinor,
      lineTotalMinor,
      variant: variant
        ? {
            id: variant.id,
            sku: variant.sku,
            size: variant.size,
            colourName: variant.colourName,
            colourHex: variant.colourHex,
            status: variant.status,
          }
        : null,
      product: product
        ? {
            id: product.id,
            slug: product.slug,
            title: product.title,
            material: product.material,
            embroidery: product.embroidery,
            availabilityMode: product.availabilityMode,
            leadTimeDays: product.leadTimeDays,
            image: coverImage,
          }
        : null,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
    };
  });

  const subtotalMinor = items.reduce((sum: number, it: any) => sum + it.lineTotalMinor, 0);
  const totalItems = items.reduce((sum: number, it: any) => sum + it.quantity, 0);

  return {
    id: cart.id,
    userId: cart.userId,
    guestProfileId: cart.guestProfileId,
    currency: cart.currency || "INR",
    status: cart.status,
    items,
    subtotalMinor,
    totalItems,
    createdAt: cart.createdAt,
    updatedAt: cart.updatedAt,
  };
}

/**
 * Retrieve current active cart
 */
export async function getActiveCart(owner: CartOwner) {
  const whereClause = owner.userId
    ? { userId: owner.userId, status: "ACTIVE" }
    : { guestProfileId: owner.guestProfileId, status: "ACTIVE" };

  return prisma.cart.findFirst({
    where: whereClause,
    include: {
      items: {
        orderBy: { createdAt: "asc" },
        include: {
          variant: {
            include: {
              product: {
                include: {
                  images: { orderBy: { sortOrder: "asc" } },
                },
              },
            },
          },
        },
      },
    },
  });
}

/**
 * Ensure an active cart exists for owner
 */
export async function getOrCreateActiveCart(owner: CartOwner) {
  let cart = await getActiveCart(owner);
  if (!cart) {
    cart = await prisma.cart.create({
      data: {
        userId: owner.userId,
        guestProfileId: owner.guestProfileId,
        currency: "INR",
        status: "ACTIVE",
      },
      include: {
        items: {
          include: {
            variant: {
              include: {
                product: {
                  include: {
                    images: { orderBy: { sortOrder: "asc" } },
                  },
                },
              },
            },
          },
        },
      },
    });
  }
  return cart;
}

/**
 * Add an item with variant validation to active cart
 */
export async function addItemToCart(owner: CartOwner, variantId: string, quantity = 1) {
  // Validate variant & product
  const variant = await prisma.productVariant.findUnique({
    where: { id: variantId },
    include: { product: true },
  });

  if (!variant || variant.status !== "Active" || variant.product.status !== "Active" || variant.product.deletedAt) {
    throw new Error("Variant is inactive or not found");
  }

  const cart = await getOrCreateActiveCart(owner);
  const unitPriceSnapshotMinor = variant.priceOverrideMinor ?? variant.product.basePriceMinor;

  const existingItem = await prisma.cartItem.findFirst({
    where: {
      cartId: cart.id,
      variantId,
    },
  });

  if (existingItem) {
    await prisma.cartItem.update({
      where: { id: existingItem.id },
      data: {
        quantity: existingItem.quantity + quantity,
        unitPriceSnapshotMinor, // Update snapshot to latest price
      },
    });
  } else {
    await prisma.cartItem.create({
      data: {
        cartId: cart.id,
        variantId,
        quantity,
        unitPriceSnapshotMinor,
      },
    });
  }

  return getActiveCart(owner);
}

/**
 * Update cart item quantity
 */
export async function updateCartItemQuantity(owner: CartOwner, itemId: string, quantity: number) {
  const cart = await getActiveCart(owner);
  if (!cart) {
    throw new Error("Active cart not found");
  }

  const existingItem = await prisma.cartItem.findFirst({
    where: {
      id: itemId,
      cartId: cart.id,
    },
  });

  if (!existingItem) {
    throw new Error("Cart item not found");
  }

  if (quantity <= 0) {
    await prisma.cartItem.delete({
      where: { id: itemId },
    });
  } else {
    await prisma.cartItem.update({
      where: { id: itemId },
      data: { quantity },
    });
  }

  return getActiveCart(owner);
}

/**
 * Remove an item from active cart
 */
export async function removeCartItem(owner: CartOwner, itemId: string) {
  const cart = await getActiveCart(owner);
  if (!cart) {
    throw new Error("Active cart not found");
  }

  const existingItem = await prisma.cartItem.findFirst({
    where: {
      id: itemId,
      cartId: cart.id,
    },
  });

  if (!existingItem) {
    throw new Error("Cart item not found");
  }

  await prisma.cartItem.delete({
    where: { id: itemId },
  });

  return getActiveCart(owner);
}

/**
 * Clear all items from active cart
 */
export async function clearActiveCart(owner: CartOwner) {
  const cart = await getActiveCart(owner);
  if (cart) {
    await prisma.cartItem.deleteMany({
      where: { cartId: cart.id },
    });
  }
  return getActiveCart(owner);
}
