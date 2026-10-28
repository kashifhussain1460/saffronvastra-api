import { Router } from "express";
import {
  handleGetCategories,
  handleGetCategoryBySlug,
  handleGetCollections,
  handleGetCollectionBySlug,
  handleGetProducts,
  handleGetProductBySlug,
  handleSearch,
  handleCreateCategory,
  handleUpdateCategory,
  handleReorderCategories,
  handleDeleteCategory,
  handleCreateProduct,
  handleUpdateProduct,
  handleGetProductById,
  handleGetProductsByIds,
  handleDeleteProduct,
  handleRestoreProduct,
  handleTogglePublishProduct,
  handleCreateCollection,
  handleUpdateCollection,
  handleDeleteCollection,
} from "./catalogue.controller.js";
import { requireAdmin } from "../../common/auth.middleware.js";

export const catalogueRouter = Router();

// Public routes
catalogueRouter.get("/categories", handleGetCategories);
catalogueRouter.get("/categories/:slug", handleGetCategoryBySlug);
catalogueRouter.get("/collections", handleGetCollections);
catalogueRouter.get("/collections/:slug", handleGetCollectionBySlug);
catalogueRouter.get("/products", handleGetProducts);
catalogueRouter.get("/products/by-ids", handleGetProductsByIds); // before /products/:slug
catalogueRouter.get("/products/:slug", handleGetProductBySlug);
catalogueRouter.get("/search", handleSearch);

// Admin routes
export const adminCatalogueRouter = Router();
adminCatalogueRouter.use(requireAdmin);

adminCatalogueRouter.get("/categories", handleGetCategories);
adminCatalogueRouter.post("/categories", handleCreateCategory);
adminCatalogueRouter.post("/categories/reorder", handleReorderCategories);
adminCatalogueRouter.patch("/categories/:id", handleUpdateCategory);
adminCatalogueRouter.delete("/categories/:id", handleDeleteCategory);

adminCatalogueRouter.get("/collections", handleGetCollections);
adminCatalogueRouter.post("/collections", handleCreateCollection);
adminCatalogueRouter.patch("/collections/:id", handleUpdateCollection);
adminCatalogueRouter.delete("/collections/:id", handleDeleteCollection);

adminCatalogueRouter.get("/products", handleGetProducts);
adminCatalogueRouter.get("/products/:id", handleGetProductById);
adminCatalogueRouter.post("/products", handleCreateProduct);
adminCatalogueRouter.patch("/products/:id", handleUpdateProduct);
adminCatalogueRouter.post("/products/:id/publish", handleTogglePublishProduct);
adminCatalogueRouter.delete("/products/:id", handleDeleteProduct); // soft delete
adminCatalogueRouter.post("/products/:id/restore", handleRestoreProduct);
