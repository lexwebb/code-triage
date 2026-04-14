/** @type {import('eslint').Rule.RuleModule} */
export default {
  meta: {
    type: "suggestion",
    docs: {
      description: "Disallow template literals in className — use cn() from lib/utils instead",
    },
    messages: {
      usesCn: "Use cn() instead of a template literal for className. Import cn from '@/lib/utils' or '../lib/utils'.",
    },
    schema: [],
  },
  create(context) {
    return {
      JSXAttribute(node) {
        if (
          node.name.type === "JSXIdentifier" &&
          node.name.name === "className" &&
          node.value?.type === "JSXExpressionContainer" &&
          node.value.expression.type === "TemplateLiteral"
        ) {
          context.report({ node: node.value, messageId: "usesCn" });
        }
      },
    };
  },
};
