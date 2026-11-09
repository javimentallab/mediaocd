"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.SearchController = void 0;
var _typescriptRoutesToOpenapiServer = require("typescript-routes-to-openapi-server");
var _metadataProviders = require("../metadata/metadataProviders");
var _mediaItem = require("../repository/mediaItem");
var _fuzzy = require("../search/fuzzy");
/**
 * @openapi_tags Search
 */
class SearchController {
  /**
   * @openapi_operationId search
   */
  search = (0, _typescriptRoutesToOpenapiServer.createExpressRoute)(async (req, res) => {
    var _query$trim;
    const userId = Number(req.user);
    const {
      mediaType,
      q: query
    } = req.query;
    if (typeof query !== 'string' || (query === null || query === void 0 || (_query$trim = query.trim()) === null || _query$trim === void 0 ? void 0 : _query$trim.length) === 0) {
      res.sendStatus(400);
      return;
    }
    if (!_metadataProviders.metadataProviders.has(mediaType)) {
      throw new Error(`No metadata provider for "${mediaType}"`);
    }
    const metadataProvider = _metadataProviders.metadataProviders.get(mediaType);
    let searchResult = await metadataProvider.search(query);
    /*mediaocd:forgiving-search*/
    let local = [];
    if (!searchResult || searchResult.length === 0) {
      local = (await _fuzzy.searchIds(query, mediaType, { strict: true }).catch(() => [])).slice(0, 20);
      for (const other of await _fuzzy.corrections(query, mediaType).catch(() => [])) {
        searchResult = await metadataProvider.search(other).catch(() => []);
        if (searchResult && searchResult.length) break;
      }
    }
    const result = await _mediaItem.mediaItemRepository.mergeSearchResultWithExistingItems(searchResult || [], mediaType);
    const ids = [...new Set([...local, ...result.map(item => item.id)])];
    const existingItemsDetails = await _mediaItem.mediaItemRepository.items({
      userId: userId,
      mediaItemIds: ids
    });
    existingItemsDetails.sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id));
    res.send(existingItemsDetails);
  });
}
exports.SearchController = SearchController;
//# sourceMappingURL=search.js.map