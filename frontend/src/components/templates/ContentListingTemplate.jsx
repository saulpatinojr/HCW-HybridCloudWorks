import React, { useState } from 'react';
import { Helmet } from 'react-helmet-async';

import { useProviderConfig } from '@/context/ProviderContext';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardHeader, CardTitle, CardContent, CardFooter } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Search, Calendar, User, ArrowRight, Loader2 } from 'lucide-react';

function renderContentCard(item, index, itemType, actionLabel) {
  switch (itemType) {
    case 'architecture':
      return (
        <Card
          key={index}
          className="group hover:border-primary/60 transition-all duration-300 bg-card/40 hover:shadow-lg hover:shadow-primary/10"
        >
          <CardHeader className="pb-2">
            <div className="flex items-start justify-between mb-2">
              <Badge variant="outline" className="text-xs">
                {item.category || 'Architecture'}
              </Badge>
              {item.complexity && (
                <Badge variant="secondary" className="text-xs">
                  {item.complexity}
                </Badge>
              )}
            </div>
            <CardTitle className="group-hover:text-primary transition-colors">
              {item.title}
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-0">
            <p className="text-muted-foreground text-sm line-clamp-3 mb-4">{item.description}</p>
            {item.tags && (
              <div className="flex flex-wrap gap-2">
                {item.tags.slice(0, 3).map((tag, i) => (
                  <span
                    key={i}
                    className="text-xs px-2 py-1 rounded-full bg-primary/10 text-primary"
                  >
                    {tag}
                  </span>
                ))}
              </div>
            )}
          </CardContent>
          <CardFooter className="flex justify-between items-center pt-2">
            <span className="text-xs text-muted-foreground">{item.date || 'Recently Updated'}</span>
            <Button variant="ghost" size="sm" className="gap-1 group-hover:text-primary">
              {actionLabel || 'View Details'} <ArrowRight className="h-3 w-3" />
            </Button>
          </CardFooter>
        </Card>
      );

    case 'blog':
    default:
      return (
        <Card
          key={index}
          className="group hover:border-primary/60 transition-all duration-300 bg-card/40 hover:shadow-lg hover:shadow-primary/10"
        >
          <CardHeader className="pb-2">
            {/* An absent date renders nothing at all. This used to fall back to
                the literal 'Feb 10, 2026', which stamped a specific publication
                date onto any item that had none — a fabricated fact rather than
                a placeholder, and indistinguishable from a real one on screen.
                The row itself is conditional too: an item with neither date nor
                author would otherwise leave an empty mb-2 div above the title,
                and the bullet separator only appears when it has both sides. */}
            {(item.date || item.author) && (
              <div className="flex items-center gap-2 mb-2 text-xs text-muted-foreground">
                {item.date && (
                  <>
                    <Calendar className="h-3 w-3" />
                    <span>{item.date}</span>
                  </>
                )}
                {item.author && (
                  <>
                    {item.date && <span>•</span>}
                    <User className="h-3 w-3" />
                    <span>{item.author}</span>
                  </>
                )}
              </div>
            )}
            <CardTitle className="group-hover:text-primary transition-colors line-clamp-2">
              {item.title}
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-0">
            <p className="text-muted-foreground text-sm line-clamp-3">
              {item.description || item.excerpt}
            </p>
          </CardContent>
          <CardFooter className="flex justify-between items-center pt-2">
            {item.category && (
              <Badge variant="secondary" className="text-xs">
                {item.category}
              </Badge>
            )}
            <Button variant="ghost" size="sm" className="gap-1 group-hover:text-primary ml-auto">
              {actionLabel || 'Read More'} <ArrowRight className="h-3 w-3" />
            </Button>
          </CardFooter>
        </Card>
      );
  }
}

// Wraps a card so clicking it calls onItemClick with its item.
function clickableCard(card, item, onItemClick) {
  if (!onItemClick) return card;
  return React.cloneElement(card, {
    onClick: () => onItemClick(item),
    className: `${card.props.className || ''} cursor-pointer`,
  });
}

// The grid area: loading, error, the cards, or why there are none.
function ListingGridState({
  loading,
  error,
  items,
  filteredItems,
  itemType,
  actionLabel,
  onItemClick,
  onClearFilters,
}) {
  if (loading) {
    return (
      <div className="flex justify-center items-center min-h-[400px]">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="text-center py-20">
        <p className="text-destructive text-lg">Failed to load content.</p>
        <p className="text-muted-foreground text-sm mt-2">{error}</p>
      </div>
    );
  }

  if (filteredItems.length > 0) {
    return (
      <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6">
        {filteredItems.map((item, index) =>
          clickableCard(renderContentCard(item, index, itemType, actionLabel), item, onItemClick)
        )}
      </div>
    );
  }

  if (items.length === 0) {
    // Nothing published for this provider and type at all (issue #373).
    // The filter message below would invite the reader to clear filters
    // that are not the reason; say the true thing instead.
    return (
      <div className="text-center py-20">
        <p className="text-muted-foreground text-lg">No {itemType}s published yet.</p>
        <p className="text-muted-foreground text-sm mt-2">Check back soon for updates.</p>
      </div>
    );
  }

  return (
    <div className="text-center py-20">
      <p className="text-muted-foreground text-lg">No {itemType}s found matching your criteria.</p>
      <Button variant="outline" className="mt-4" onClick={onClearFilters}>
        Clear Filters
      </Button>
    </div>
  );
}

/**
 * Enhanced Content Hub Template for Blog/Architecture listings
 * @param {string} title - Page title
 * @param {string} description - Page description
 * @param {Array} items - Content items to display
 * @param {string} itemType - Type of content ('blog', 'architecture', 'framework')
 */
export function ContentListingTemplate({
  title,
  description,
  items = [],
  itemType = 'blog',
  loading = false,
  error = null,
  categories = [],
  icon = null,
  onItemClick = null,
  actionLabel = null,
}) {
  const providerConfig = useProviderConfig();
  const _theme = providerConfig?._theme; // Optional - only used when wrapped in ProviderLayout
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedCategory, setSelectedCategory] = useState('all');

  const filteredItems = items.filter((item) => {
    const matchesSearch =
      item.title?.toLowerCase().includes(searchTerm.toLowerCase()) ||
      item.description?.toLowerCase().includes(searchTerm.toLowerCase());
    const matchesCategory = selectedCategory === 'all' || item.category === selectedCategory;
    return matchesSearch && matchesCategory;
  });

  return (
    <main className="flex-grow pt-28 pb-20 px-4 md:px-8 max-w-[1600px] mx-auto w-full">
      <Helmet>
        <title>{`${title} | HCW`}</title>
        <meta name="description" content={description} />
      </Helmet>

      {/* Header */}
      <div className="flex items-center gap-4 mb-4">
        {icon && (
          <div className="bg-primary p-3 rounded-xl flex items-center justify-center shadow-[0_0_15px_rgba(var(--primary-rgb),0.3)]">
            <span className="material-symbols-outlined text-primary-foreground text-2xl font-bold">
              {icon}
            </span>
          </div>
        )}
        <h1 className="text-3xl sm:text-5xl md:text-6xl font-bold text-slate-900 dark:text-white">
          {title}
        </h1>
      </div>
      <p className="text-muted-foreground text-base sm:text-lg max-w-3xl mb-12">{description}</p>

      {/* Filters */}
      <div className="flex flex-col md:flex-row gap-4 mb-8 items-start md:items-center justify-between">
        <div className="relative w-full md:w-96">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder={`Search ${itemType}s...`}
            className="pl-10"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            aria-label={`Search ${itemType}s...`}
          />
        </div>

        {categories.length > 0 && (
          <div className="flex gap-2 flex-wrap">
            <Button
              variant={selectedCategory === 'all' ? 'default' : 'outline'}
              size="sm"
              onClick={() => setSelectedCategory('all')}
            >
              All
            </Button>
            {categories.map((cat) => (
              <Button
                key={cat}
                variant={selectedCategory === cat ? 'default' : 'outline'}
                size="sm"
                onClick={() => setSelectedCategory(cat)}
              >
                {cat}
              </Button>
            ))}
          </div>
        )}
      </div>

      {/* Content Grid */}
      <ListingGridState
        loading={loading}
        error={error}
        items={items}
        filteredItems={filteredItems}
        itemType={itemType}
        actionLabel={actionLabel}
        onItemClick={onItemClick}
        onClearFilters={() => {
          setSearchTerm('');
          setSelectedCategory('all');
        }}
      />
    </main>
  );
}

export default ContentListingTemplate;
