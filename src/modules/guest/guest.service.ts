import { prisma } from "../../database/prisma.js";
import { generateUUID, hashToken } from "../../common/crypto.utils.js";

export async function bootstrapGuest(existingGuestId?: string) {
  let guestProfile = null;
  let guestId = existingGuestId;

  if (existingGuestId) {
    const hash = hashToken(existingGuestId);
    guestProfile = await prisma.guestProfile.findUnique({
      where: { guestIdHash: hash },
    });
  }

  let isNew = false;
  if (!guestProfile) {
    guestId = generateUUID();
    const hash = hashToken(guestId);
    guestProfile = await prisma.guestProfile.create({
      data: {
        guestIdHash: hash,
        consentState: { analytics: true, essential: true },
      },
    });
    isNew = true;
  } else {
    // Update last seen
    await prisma.guestProfile.update({
      where: { id: guestProfile.id },
      data: { lastSeenAt: new Date() },
    });
  }

  // Create a tracking session for this visit
  const sessionKey = generateUUID();
  const sessionKeyHash = hashToken(sessionKey);
  const now = new Date();
  const trackingSession = await prisma.trackingSession.create({
    data: {
      guestProfileId: guestProfile.id,
      sessionKeyHash,
      consentState: { analytics: true },
      startedAt: now,
      lastSeenAt: now,
    },
  });

  await prisma.sessionSummary.create({
    data: {
      trackingSessionId: trackingSession.id,
      windowStart: now,
      windowEnd: now,
      pageViews: 0,
      uniqueProducts: 0,
      activeSeconds: 0,
      cartActions: 0,
    },
  });

  return {
    guestId: guestId!,
    guestProfileId: guestProfile.id,
    trackingSessionId: trackingSession.id,
    isNew,
  };
}

export async function mergeGuestDataToUser(guestId: string, userId: string) {
  const hash = hashToken(guestId);
  const guestProfile = await prisma.guestProfile.findUnique({
    where: { guestIdHash: hash },
  });

  if (!guestProfile) {
    return { merged: false, reason: "Guest profile not found" };
  }

  // 1. Link tracking sessions
  await prisma.trackingSession.updateMany({
    where: { guestProfileId: guestProfile.id, userId: null },
    data: { userId },
  });

  // 2. Merge Carts
  const guestCart = await prisma.cart.findFirst({
    where: { guestProfileId: guestProfile.id, status: "ACTIVE" },
    include: { items: true },
  });

  if (guestCart && guestCart.items.length > 0) {
    let userCart = await prisma.cart.findFirst({
      where: { userId, status: "ACTIVE" },
      include: { items: true },
    });

    if (!userCart) {
      // Reassign guest cart directly to user
      await prisma.cart.update({
        where: { id: guestCart.id },
        data: { userId, guestProfileId: null },
      });
    } else {
      // Merge items from guest cart into user cart
      for (const item of guestCart.items) {
        const existingItem = userCart.items.find((i) => i.variantId === item.variantId);
        if (existingItem) {
          await prisma.cartItem.update({
            where: { id: existingItem.id },
            data: { quantity: existingItem.quantity + item.quantity },
          });
        } else {
          await prisma.cartItem.create({
            data: {
              cartId: userCart.id,
              variantId: item.variantId,
              quantity: item.quantity,
              unitPriceSnapshotMinor: item.unitPriceSnapshotMinor,
            },
          });
        }
      }
      // Mark guest cart as converted
      await prisma.cart.update({
        where: { id: guestCart.id },
        data: { status: "CONVERTED" },
      });
    }
  }

  // 3. Merge Wishlists
  const guestWishlist = await prisma.wishlist.findFirst({
    where: { guestProfileId: guestProfile.id },
    include: { items: true },
  });

  if (guestWishlist && guestWishlist.items.length > 0) {
    let userWishlist = await prisma.wishlist.findFirst({
      where: { userId },
      include: { items: true },
    });

    if (!userWishlist) {
      await prisma.wishlist.update({
        where: { id: guestWishlist.id },
        data: { userId, guestProfileId: null },
      });
    } else {
      for (const item of guestWishlist.items) {
        const alreadyInWishlist = userWishlist.items.some((i) => i.productId === item.productId);
        if (!alreadyInWishlist) {
          await prisma.wishlistItem.create({
            data: {
              wishlistId: userWishlist.id,
              productId: item.productId,
              variantId: item.variantId,
            },
          });
        }
      }
    }
  }

  return { merged: true, guestProfileId: guestProfile.id };
}
