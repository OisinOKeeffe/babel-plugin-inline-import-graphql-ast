import path, { dirname } from 'path'
import { EOL } from 'os'
import { readFileSync } from 'fs'
import gql from 'graphql-tag'

let resolve

export default ({ types: t }) => ({
  manipulateOptions ({ resolveModuleSource }) {
    if (!resolve) {
      resolve = resolveModuleSource || ((src, file) => path.resolve(dirname(file), src))
    }
  },
  visitor: {
    ImportDeclaration: {
      exit (curPath, state) {
        const importPath = curPath.node.source.value
        if (importPath.endsWith('.graphql') || importPath.endsWith('.gql')) {
          const query = createQuery(importPath, state.file.opts.filename)
          query.processFragments()
          query.parse()
          query.dedupeFragments()
          query.makeSourceEnumerable()
          replaceImportStatement(query.ast)
        }

        // This function replaces the .gql import statement with code roughly equivalent to...
        // let myQuery = `${graphqlAST}`;
        // myQuery = JSON.parse(myQuery);
        //
        // This is meant to avoid problems encountered when creating Babel AST from GraphQL AST by
        // simply "storing" the GraphQL AST as a string before parsing it into an object at runtime.
        function replaceImportStatement (graphqlAST) {
          const inlineVarName = curPath.node.specifiers[0].local.name

          curPath.replaceWithMultiple([
            t.variableDeclaration('let', [
              t.variableDeclarator(
                t.identifier(inlineVarName),
                t.stringLiteral(JSON.stringify(graphqlAST))
              )
            ]),
            t.assignmentExpression(
              '=',
              t.identifier(inlineVarName),
              t.callExpression(t.memberExpression(t.identifier('JSON'), t.identifier('parse')), [
                t.identifier(inlineVarName)
              ])
            )
          ])
        }
      }
    }
  }
})

function createQuery (queryPath, babelPath) {
  const absPath = resolve(queryPath, babelPath)
  const source = readFileSync(absPath).toString()
  let ast = null
  let fragmentDefs = []

  return {
    processFragments () {
      processImports(getImportStatements(source), absPath)

      function getImportStatements (src) {
        return src.split(EOL).filter(line => line.startsWith('#import'))
      }

      function processImports (imports, relFile) {
        imports.forEach(statement => {
          const fragmentPath = statement.split(' ')[1].slice(1, -1)
          const absFragmentPath = resolve(fragmentPath, relFile)
          const fragmentSource = readFileSync(absFragmentPath).toString()
          const subFragments = getImportStatements(fragmentSource)
          if (subFragments.length > 0) {
            processImports(subFragments, absFragmentPath)
          }
          fragmentDefs = [...gql`${fragmentSource}`.definitions, ...fragmentDefs]
        })
      }
    },
    parse () {
      const parsedAST = gql`${source}`
      parsedAST.definitions = [...parsedAST.definitions, ...fragmentDefs]
      ast = parsedAST
    },
    dedupeFragments () {
      let seenNames = {}
      ast.definitions = ast.definitions.filter(def => {
        if (def.kind !== 'FragmentDefinition') return true
        return seenNames[def.name.value] ? false : (seenNames[def.name.value] = true)
      })
    },
    makeSourceEnumerable () {
      const newAST = JSON.parse(JSON.stringify(ast))
      newAST.loc.source = ast.loc.source
      ast = newAST
    },
    get ast () {
      return ast
    }
  }
}
